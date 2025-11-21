
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const { ethers } = require('ethers');
const { Ed25519Keypair } = require('@mysten/sui/keypairs/ed25519');
const { SuiClient, getFullnodeUrl } = require('@mysten/sui/client');
const { Transaction } = require('@mysten/sui/transactions');
const { fromB64 } = require('@mysten/bcs');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3001;
const WORMHOLE_API = process.env.WORMHOLE_API_BASE || "https://api.testnet.wormholescan.io/api/v1/operations";

// --- 状态管理 ---
// 1. 轮询池：存放等待 VAA 的 txHash Set<string>
const pollingPool = new Set(); 

// 2. 提交队列：存放已拿到 VAA 等待上链的任务 Array<{txHash, vaaBase64, emitterChain}>
const bscQueue = [];
const suiQueue = [];

// 锁状态，防止同一个队列并发执行导致 Nonce 错乱
let isBscProcessing = false;
let isSuiProcessing = false;

// --- API 接口 ---

/**
 * 接收前端提交的交易哈希，加入轮询池
 * POST /api/relay
 * Body: { txHash: string }
 */
app.post('/api/relay', (req, res) => {
    const { txHash } = req.body;
    if (!txHash) return res.status(400).json({ error: "Missing txHash" });

    if (pollingPool.has(txHash)) {
        return res.json({ message: "Transaction is already being monitored" });
    }

    // 简单去重：检查是否已经在处理队列中（这里简化处理，实际上可以用 Map 记录全局状态）
    if (bscQueue.find(t => t.txHash === txHash) || suiQueue.find(t => t.txHash === txHash)) {
        return res.json({ message: "Transaction is already queued for submission" });
    }

    console.log(`[API] 收到新的跨链请求，加入轮询池: ${txHash}`);
    pollingPool.add(txHash);
    res.json({ success: true, message: "Transaction added to relay queue" });
});

/**
 * 健康检查
 */
app.get('/health', (req, res) => {
    res.json({ 
        status: "ok", 
        polling: pollingPool.size, 
        bscQueue: bscQueue.length, 
        suiQueue: suiQueue.length 
    });
});

// --- Worker 1: 轮询器 (Poller) ---
// 负责不停询问 Wormhole API "VAA 生成了吗？"
setInterval(async () => {
    if (pollingPool.size === 0) return;

    const hashesToCheck = Array.from(pollingPool);
    
    // 并发查询（限制一下并发数更好，这里为了简单直接 Promise.all）
    // 实际生产环境建议使用 p-limit 或类似库限制并发
    await Promise.all(hashesToCheck.map(async (txHash) => {
        try {
            // 调用 Wormhole Scan API
            const response = await axios.get(`${WORMHOLE_API}?txHash=${txHash}`, {
                timeout: 5000 
            });
            const data = response.data;

            // 检查 API 返回的数据结构
            if (data && data.operations && data.operations.length > 0) {
                const op = data.operations[0];
                
                // 确保拿到 VAA (raw base64)
                if (op.vaa && op.vaa.raw) {
                    const vaaBase64 = op.vaa.raw;
                    const emitterChain = op.emitterChain; // 4=BSC, 21=Sui, etc.

                    console.log(`[Poller] ✅ 捕获到 VAA! TxHash: ${txHash}, 源链ID: ${emitterChain}`);
                    
                    // 既然已经拿到 VAA，从轮询池移除
                    pollingPool.delete(txHash);

                    const task = { txHash, vaaBase64 };
                    
                    // 路由分发：
                    // 如果源链是 BSC (4)，则目标链是 Sui -> 推入 Sui 队列
                    // 如果源链是 Sui (21)，则目标链是 BSC -> 推入 BSC 队列
                    if (emitterChain === 4) {
                        console.log(`[Dispatcher] -> 目标是 Sui，推入 Sui 队列`);
                        suiQueue.push(task);
                    } else if (emitterChain === 21) {
                        console.log(`[Dispatcher] -> 目标是 BSC，推入 BSC 队列`);
                        bscQueue.push(task);
                    } else {
                        console.warn(`[Dispatcher] 未知源链 ID: ${emitterChain}，丢弃任务`);
                    }
                }
            }
        } catch (e) {
            // 忽略 404 (未找到) 或 网络错误，下次继续轮询
            if (e.response && e.response.status !== 404) {
                console.error(`[Poller Error] 查询 ${txHash} 失败: ${e.message}`);
            }
        }
    }));
}, 5000); // 每 5 秒轮询一次

// --- Worker 2: BSC 消费者 (串行执行) ---
// 处理从其他链跨回到 BSC 的请求
setInterval(async () => {
    // 如果正在处理中，或者队列为空，直接跳过
    if (isBscProcessing || bscQueue.length === 0) return;
    
    // 加锁
    isBscProcessing = true;
    const task = bscQueue.shift(); // 取出队首任务

    console.log(`[BSC Worker] 开始处理任务: ${task.txHash}`);

    try {
        // 初始化 Provider 和 Wallet
        // 使用公共 RPC，建议在 .env 中配置备用节点
        const rpcUrl = process.env.BSC_RPC || "https://data-seed-prebsc-1-s1.binance.org:8545"; 
        const provider = new ethers.JsonRpcProvider(rpcUrl);
        const wallet = new ethers.Wallet(process.env.BSC_PRIVATE_KEY, provider);
        
        const contractAddress = process.env.SURGE_EXECUTOR_BSC;
        if (!contractAddress) throw new Error("BSC Contract Address not configured");

        // 最小 ABI，只需要 completeTransfer
        const abi = ["function completeTransfer(bytes calldata encodedVm) external"];
        const contract = new ethers.Contract(contractAddress, abi, wallet);

        // 将 Base64 VAA 转换为 Buffer (Bytes)
        const vaaBytes = Buffer.from(task.vaaBase64, 'base64');
        
        // 发送交易
        // 这里的 gasLimit 可以根据实际情况调整或估算
        console.log(`[BSC Worker] 发送交易中...`);
        const tx = await contract.completeTransfer(vaaBytes);
        console.log(`[BSC Worker] 交易已发送: ${tx.hash}`);
        
        // 等待上链确认
        await tx.wait();
        console.log(`[BSC Worker] ✅ 交易确认成功!`);

    } catch (e) {
        console.error(`[BSC Worker Error] 处理失败: ${e.message}`);
        // 简单的重试策略：如果失败，是否放回队列？
        // 为了防止死循环，这里暂时不放回，实际生产环境应该有死信队列(DLQ)
        // bscQueue.push(task); 
    } finally {
        // 释放锁
        isBscProcessing = false;
    }
}, 2000); // 每 2 秒检查一次队列

// --- Worker 3: Sui 消费者 (串行执行) ---
// 处理从其他链跨回到 Sui 的请求
setInterval(async () => {
    if (isSuiProcessing || suiQueue.length === 0) return;

    isSuiProcessing = true;
    const task = suiQueue.shift();

    console.log(`[Sui Worker] 开始处理任务: ${task.txHash}`);

    try {
        // 初始化 Sui Client
        const rpcUrl = process.env.SUI_RPC || getFullnodeUrl('testnet');
        const client = new SuiClient({ url: rpcUrl });

        // 初始化 Keypair
        // 假设环境变量中的 SUI_PRIVATE_KEY 是 Base64 编码的私钥 (这是 Sui CLI/Wallet 标准导出格式之一)
        // 如果是 bech32 (suiprivkey...) 需要用 decodeSuiPrivateKey 解析
        // 这里为了通用性，假设是直接导出的 Base64 密钥部分
        let privateKey = process.env.SUI_PRIVATE_KEY;
        let keypair;
        
const { decodeSuiPrivateKey } = require('@mysten/sui/cryptography');

// ...

        try {
             // 支持 suiprivkey (Bech32) 或 Base64 格式
             let keypair;
             if (privateKey.startsWith('suiprivkey')) {
                 const { secretKey } = decodeSuiPrivateKey(privateKey);
                 keypair = Ed25519Keypair.fromSecretKey(secretKey);
             } else {
                 // 尝试作为 base64 密钥处理
                 const rawKey = fromB64(privateKey);
                 // 剔除可能的 flag byte (ed25519 通常第一位是 0)
                 const keyBytes = rawKey.length === 33 ? rawKey.slice(1) : rawKey;
                 
                 if (keyBytes.length !== 32) {
                     throw new Error(`Invalid key length: ${keyBytes.length}. Expected 32 bytes.`);
                 }
                 
                 keypair = Ed25519Keypair.fromSecretKey(keyBytes);
             }
        } catch(err) {
             console.error("[Sui Worker] 私钥解析失败，请检查格式。支持 suiprivkey... 或 Base64");
             throw err;
        }

        const vaaBytes = Buffer.from(task.vaaBase64, 'base64');
        // Sui Move Call 需要 vector<u8>，在 JS SDK 中通常传 Uint8Array 或 array
        const vaaArray = new Uint8Array(vaaBytes);

        const tx = new Transaction();
        
        // 配置 Object ID
        const packageId = process.env.SURGE_PACKAGE_ID;
        const wormholeStateId = process.env.WORMHOLE_STATE_ID; // Wormhole 核心状态对象
        const surgeBridgeStateId = process.env.SURGE_BRIDGE_STATE_ID; // Surge Bridge State
        const clockId = "0x6";                                 // 系统 Clock

        if (!packageId || !wormholeStateId || !surgeBridgeStateId) {
            throw new Error("Sui Contract Config missing in .env");
        }

        // 调用 unlock (Move function name is unlock in surge.move)
        // public fun unlock(
        //     surge_state: &mut SurgeBridgeState,
        //     state: &mut State,
        //     buf: vector<u8>,
        //     clock: &Clock,
        //     ctx: &mut TxContext
        // )
        tx.moveCall({
            target: `${packageId}::surge::unlock`,
            arguments: [
                tx.object(surgeBridgeStateId), // 1. SurgeBridgeState
                tx.object(wormholeStateId),    // 2. Wormhole State
                tx.pure(vaaArray),             // 3. VAA Bytes
                tx.object(clockId)             // 4. Clock
            ]
        });

        console.log(`[Sui Worker] 提交交易...`);
        const result = await client.signAndExecuteTransactionBlock({
            signer: keypair,
            transactionBlock: tx,
            options: {
                showEffects: true,
                showEvents: true
            }
        });

        if (result.effects.status.status === 'success') {
            console.log(`[Sui Worker] ✅ 交易成功! Digest: ${result.digest}`);
        } else {
            console.error(`[Sui Worker] ❌ 交易失败: ${result.effects.status.error}`);
        }

    } catch (e) {
        console.error(`[Sui Worker Error] 处理失败: ${e.message}`);
    } finally {
        isSuiProcessing = false;
    }
}, 2000);

// 启动服务
app.listen(PORT, () => {
    console.log(`
    🚀 Relayer Service running on port ${PORT}
    ------------------------------------------
    - BSC RPC: ${process.env.BSC_RPC || 'Default Public'}
    - Sui RPC: ${process.env.SUI_RPC || 'Default Testnet'}
    - Wormhole API: ${WORMHOLE_API}
    `);
});

