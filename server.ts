import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { SuiClient } from '@mysten/sui/client';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { Transaction } from '@mysten/sui/transactions';
import { ethers } from 'ethers';

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3001;

// ==================== Sui 配置 ====================
const SUI_PACKAGE_ID = process.env.SUI_PACKAGE_ID!;
const SUI_BRIDGE_STATE = process.env.SUI_BRIDGE_STATE!;
const SUI_STATE = process.env.SUI_STATE!;
const SUI_RPC_URL = process.env.SUI_RPC_URL || 'https://fullnode.testnet.sui.io';

// ==================== BSC 配置 ====================
const BSC_RPC_URL = process.env.BSC_RPC_URL || 'https://data-seed-prebsc-1-s1.binance.org:8545';
const BSC_EXECUTOR_ADDRESS = process.env.BSC_EXECUTOR_ADDRESS!;
const BSC_PRIVATE_KEY = process.env.BSC_PRIVATE_KEY!;

// ==================== Wormhole 配置 ====================
const WORMHOLE_API = 'https://api.testnet.wormholescan.io/api/v1/operations';

// Wormhole Chain IDs
const CHAIN_ID_BSC = 4;
const CHAIN_ID_SUI = 21;

// 初始化客户端
let suiClient: SuiClient;
let suiKeypair: Ed25519Keypair;
let bscProvider: ethers.JsonRpcProvider;
let bscWallet: ethers.Wallet;

function initClients() {
  try {
    // 初始化 Sui
    suiClient = new SuiClient({ url: SUI_RPC_URL });
    const privateKeyBase64 = process.env.SUI_PRIVATE_KEY!;
    suiKeypair = Ed25519Keypair.fromSecretKey(privateKeyBase64);
    const suiAddress = suiKeypair.getPublicKey().toSuiAddress();
    console.log('✅ Sui 客户端初始化成功');
    console.log('📍 Sui 地址:', suiAddress);
    
    // 初始化 BSC
    bscProvider = new ethers.JsonRpcProvider(BSC_RPC_URL);
    bscWallet = new ethers.Wallet(BSC_PRIVATE_KEY, bscProvider);
    console.log('✅ BSC 客户端初始化成功');
    console.log('📍 BSC 地址:', bscWallet.address);
    
  } catch (error) {
    console.error('❌ 客户端初始化失败:', error);
    process.exit(1);
  }
}

// Base64 转字节数组
function base64ToBytes(base64: string): number[] {
  const buffer = Buffer.from(base64, 'base64');
  return Array.from(buffer);
}

// 查询 VAA
async function queryVAA(txHash: string): Promise<{ vaa: number[], raw: string, sourceChain: number } | null> {
  try {
    const url = `${WORMHOLE_API}?txHash=${txHash}`;
    console.log(`🔍 查询 VAA: ${txHash}`);
    
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    
    const data: any = await response.json();

    if (!data || !Array.isArray(data.operations) || data.operations.length === 0) {
      console.log('⏳ 操作记录未找到');
      return null;
    }
    
    const operation = data.operations[0];
    if (!operation.vaa || !operation.vaa.raw) {
      console.log('⏳ VAA 尚未生成');
      return null;
    }
    
    const vaaBytes = base64ToBytes(operation.vaa.raw);
    const sourceChain = operation.emitterChain;
    
    console.log(`✅ VAA 获取成功，长度: ${vaaBytes.length} bytes, 源链: ${sourceChain}`);
    
    return {
      vaa: vaaBytes,
      raw: operation.vaa.raw,
      sourceChain
    };
  } catch (error: any) {
    console.error('❌ 查询 VAA 失败:', error.message);
    return null;
  }
}

// 轮询查询 VAA
async function fetchVAAWithRetry(
  txHash: string, 
  maxRetries: number = 30,
  delayMs: number = 3000
): Promise<{ vaa: number[], raw: string, sourceChain: number }> {
  console.log(`🔄 开始轮询 VAA，最多 ${maxRetries} 次，间隔 ${delayMs/1000}s`);
  
  for (let i = 0; i < maxRetries; i++) {
    const result = await queryVAA(txHash);
    
    if (result) {
      return result;
    }
    
    if (i < maxRetries - 1) {
      console.log(`⏳ 第 ${i + 1}/${maxRetries} 次查询，${delayMs/1000}s 后重试...`);
      await new Promise(resolve => setTimeout(resolve, delayMs));
    }
  }
  
  throw new Error(`超过最大重试次数 ${maxRetries}，VAA 仍未就绪`);
}

// ==================== Sui 端执行 unlock ====================
async function executeUnlockOnSui(vaaBytes: number[]): Promise<string> {
  console.log('🔓 在 Sui 上执行 unlock...');
  
  const tx = new Transaction();
  
  // surge_state: &mut SurgeBridgeState,
  // state: &mut State,
  // buf: vector<u8>,
  // clock: &Clock,
  tx.moveCall({
    target: `${SUI_PACKAGE_ID}::surge::unlock`,
    arguments: [
      tx.object(SUI_BRIDGE_STATE),
      tx.object(SUI_STATE),
      tx.pure.vector('u8', vaaBytes),
      tx.object('0x6') 
    ],
  });
  
  console.log('📝 签名并提交 Sui 交易...');
  
  const result = await suiClient.signAndExecuteTransaction({
    transaction: tx,
    signer: suiKeypair,
    options: {
      showEffects: true,
      showEvents: true,
    },
  });
  
  if (result.effects?.status?.status !== 'success') {
    throw new Error(`Sui 交易失败: ${result.effects?.status?.error || '未知错误'}`);
  }
  
  console.log('✅ Sui Unlock 成功!');
  console.log('📋 Sui 交易哈希:', result.digest);
  
  return result.digest;
}

// ==================== BSC 端执行 completeTransfer ====================
async function executeCompleteTransferOnBSC(vaaBytes: number[]): Promise<string> {
  console.log('🔓 在 BSC 上执行 completeTransfer...');
  
  // SurgeBridgeExecutor ABI (只需要 completeTransfer 函数)
  const abi = [
    'function completeTransfer(bytes calldata encodedVm) external'
  ];
  
  const contract = new ethers.Contract(BSC_EXECUTOR_ADDRESS, abi, bscWallet);
  
  // 将 number[] 转为 Buffer
  const vaaBuffer = Buffer.from(vaaBytes);
  
  console.log('📝 发送 BSC 交易...');
  
  const tx = await contract.completeTransfer(vaaBuffer, {
    gasLimit: 500000 // 预设 gas limit，实际会根据网络调整
  });
  
  console.log('⏳ 等待 BSC 交易确认...');
  console.log('📋 BSC 交易哈希:', tx.hash);
  
  const receipt = await tx.wait();
  
  if (receipt.status !== 1) {
    throw new Error('BSC 交易执行失败');
  }
  
  console.log('✅ BSC CompleteTransfer 成功!');
  
  return tx.hash;
}

// ==================== API: 统一跨链接口 ====================
app.post('/api/bridge', async (req, res) => {
  const { txHash } = req.body;
  
  if (!txHash) {
    return res.status(400).json({ 
      success: false, 
      error: '缺少 txHash 参数' 
    });
  }
  
  console.log('\n' + '='.repeat(60));
  console.log('🚀 收到跨链请求:', txHash);
  console.log('='.repeat(60));
  
  try {
    // 1. 查询 VAA（带重试）
    const vaaData = await fetchVAAWithRetry(txHash);
    
    let targetChain: string;
    let targetTxHash: string;
    let explorerUrl: string;
    
    // 2. 根据源链判断目标链并执行
    if (vaaData.sourceChain === CHAIN_ID_BSC) {
      // BSC → Sui
      console.log('🌉 跨链方向: BSC → Sui');
      targetChain = 'Sui';
      targetTxHash = await executeUnlockOnSui(vaaData.vaa);
      explorerUrl = `https://testnet.suivision.xyz/txblock/${targetTxHash}`;
      
    } else if (vaaData.sourceChain === CHAIN_ID_SUI) {
      // Sui → BSC
      console.log('🌉 跨链方向: Sui → BSC');
      targetChain = 'BSC';
      targetTxHash = await executeCompleteTransferOnBSC(vaaData.vaa);
      explorerUrl = `https://testnet.bscscan.com/tx/${targetTxHash}`;
      
    } else {
      throw new Error(`不支持的源链 ID: ${vaaData.sourceChain}`);
    }
    
    res.json({
      success: true,
      message: '跨链成功',
      data: {
        sourceTxHash: txHash,
        sourceChain: vaaData.sourceChain === CHAIN_ID_BSC ? 'BSC' : 'Sui',
        targetChain,
        targetTxHash,
        vaaRaw: vaaData.raw,
        explorerUrl
      }
    });
    
    console.log('='.repeat(60));
    console.log('✅ 跨链处理完成');
    console.log('='.repeat(60) + '\n');
    
  } catch (error: any) {
    console.error('❌ 处理失败:', error.message);
    
    res.status(500).json({
      success: false,
      error: error.message || '处理失败'
    });
  }
});

// ==================== 向后兼容的 unlock 接口 ====================
app.post('/api/unlock', async (req, res) => {
  const { txHash } = req.body;
  
  if (!txHash) {
    return res.status(400).json({ 
      success: false, 
      error: '缺少 txHash 参数' 
    });
  }
  
  console.log('\n' + '='.repeat(60));
  console.log('🚀 收到 unlock 请求 (旧接口):', txHash);
  console.log('='.repeat(60));
  
  try {
    // 查询 VAA
    const vaaData = await fetchVAAWithRetry(txHash);
    
    // 只支持 BSC → Sui
    if (vaaData.sourceChain !== CHAIN_ID_BSC) {
      throw new Error(`此接口仅支持 BSC → Sui，请使用 /api/bridge 接口`);
    }
    
    const targetTxHash = await executeUnlockOnSui(vaaData.vaa);
    
    res.json({
      success: true,
      message: 'Unlock 执行成功',
      data: {
        txHash,
        vaaRaw: vaaData.raw,
        suiTxDigest: targetTxHash,
        explorerUrl: `https://testnet.suivision.xyz/txblock/${targetTxHash}`
      }
    });
    
    console.log('='.repeat(60));
    console.log('✅ 请求处理完成');
    console.log('='.repeat(60) + '\n');
    
  } catch (error: any) {
    console.error('❌ 处理失败:', error.message);
    
    res.status(500).json({
      success: false,
      error: error.message || '处理失败'
    });
  }
});

// ==================== 健康检查 ====================
app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok',
    sui: {
      rpc: SUI_RPC_URL,
      address: suiKeypair?.getPublicKey().toSuiAddress(),
      packageId: SUI_PACKAGE_ID
    },
    bsc: {
      rpc: BSC_RPC_URL,
      address: bscWallet?.address,
      executorAddress: BSC_EXECUTOR_ADDRESS
    }
  });
});

// ==================== 启动服务器 ====================
function start() {
  // 检查必需的环境变量
  const requiredEnvVars = [
    'SUI_PRIVATE_KEY',
    'SUI_PACKAGE_ID',
    'SUI_BRIDGE_STATE',
    'SUI_STATE',
    'BSC_PRIVATE_KEY',
    'BSC_EXECUTOR_ADDRESS'
  ];
  
  const missing = requiredEnvVars.filter(v => !process.env[v]);
  if (missing.length > 0) {
    console.error('❌ 缺少必需的环境变量:', missing.join(', '));
    process.exit(1);
  }
  
  // 初始化客户端
  initClients();
  
  // 启动服务器
  app.listen(PORT, () => {
    console.log('\n' + '='.repeat(60));
    console.log('🌉 Sui ⟷ BSC Bridge Server 启动成功!');
    console.log('='.repeat(60));
    console.log(`📡 监听端口: ${PORT}`);
    console.log(`\n【Sui 配置】`);
    console.log(`  RPC: ${SUI_RPC_URL}`);
    console.log(`  Package: ${SUI_PACKAGE_ID}`);
    console.log(`  地址: ${suiKeypair.getPublicKey().toSuiAddress()}`);
    console.log(`\n【BSC 配置】`);
    console.log(`  RPC: ${BSC_RPC_URL}`);
    console.log(`  Executor: ${BSC_EXECUTOR_ADDRESS}`);
    console.log(`  地址: ${bscWallet.address}`);
    console.log(`\n【Wormhole】`);
    console.log(`  API: ${WORMHOLE_API}`);
    console.log(`  BSC Chain ID: ${CHAIN_ID_BSC}`);
    console.log(`  Sui Chain ID: ${CHAIN_ID_SUI}`);
    console.log('='.repeat(60));
    console.log('支持双向跨链:');
    console.log('  • BSC → Sui (unlock)');
    console.log('  • Sui → BSC (completeTransfer)');
    console.log('='.repeat(60) + '\n');
  });
}

start();

