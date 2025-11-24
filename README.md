# Sui-BSC Bridge Server

简单的后端服务，用于处理 BSC → Sui 跨链解锁。

## 功能

1. 接收前端传来的 BSC 交易哈希
2. 查询 Wormhole API 获取 VAA
3. 自动调用 Sui 链上的 `unlock` 函数

## 安装

```bash
npm install
```

## 配置

复制 `.env.example` 为 `.env` 并填写配置：

```bash
cp .env.example .env
```

必需的环境变量：
- `SUI_PRIVATE_KEY`: Sui 私钥（Base64 格式）
- `SUI_PACKAGE_ID`: Sui 合约包 ID
- `SUI_BRIDGE_STATE`: Bridge State 对象 ID
- `SUI_STATE`: Wormhole State 对象 ID

## 运行

### 开发模式（热重载）
```bash
npm run dev
```

### 生产模式
```bash
npm run build
npm start
```

## API 接口

### POST /api/unlock

处理跨链解锁请求。

**请求体：**
```json
{
  "txHash": "0x..."
}
```

**响应：**
```json
{
  "success": true,
  "message": "Unlock 执行成功",
  "data": {
    "txHash": "0x...",
    "vaaRaw": "base64...",
    "suiTxDigest": "...",
    "explorerUrl": "https://testnet.suivision.xyz/txblock/..."
  }
}
```

### GET /health

健康检查。

**响应：**
```json
{
  "status": "ok",
  "sui": {
    "rpc": "https://fullnode.testnet.sui.io",
    "address": "0x..."
  }
}
```

## 前端调用示例

```typescript
async function unlockOnSui(bscTxHash: string) {
  const response = await fetch('http://localhost:3001/api/unlock', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      txHash: bscTxHash
    })
  });
  
  const result = await response.json();
  
  if (result.success) {
    console.log('Unlock 成功!', result.data);
    console.log('Sui 交易:', result.data.explorerUrl);
  } else {
    console.error('Unlock 失败:', result.error);
  }
}
```

## 注意事项

1. 私钥安全：生产环境请使用密钥管理服务
2. RPC 限流：公共 RPC 可能有限流，建议使用私有节点
3. Gas 费用：确保签名地址有足够的 SUI 代币支付 Gas
4. 超时设置：VAA 生成通常需要 1-3 分钟

