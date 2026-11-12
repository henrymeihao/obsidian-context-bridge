import { randomBytes, createHash } from 'node:crypto';
const key = randomBytes(32).toString('base64url');
console.log('管理员密钥（仅在本机保存，授权时在自己的 Worker 页面输入）：\n' + key);
console.log('\nOWNER_KEY_SHA256（上传为 Worker secret）：\n' + createHash('sha256').update(key).digest('hex'));
