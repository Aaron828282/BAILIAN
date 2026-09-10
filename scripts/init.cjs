'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const root=process.cwd(),envFile=path.join(root,'.env'),loginFile=path.join(root,'管理员登录.txt');
if(fs.existsSync(envFile)||fs.existsSync(loginFile)){console.error('初始化已存在，为避免覆盖密钥与密码，本次未修改。');process.exit(1);}
process.umask(0o077);
const random=()=>crypto.randomBytes(32).toString('hex'),password=random().slice(0,40);
const lines=['# 百炼中转工作台；请妥善保管本文件，特别是 VAULT_KEY。','PUBLIC_URL=http://127.0.0.1:3480','PUBLIC_HOST=relay.example.com','HOST=127.0.0.1','PORT=3480','DATA_DIR=./data','MATERIAL_PATH=./resources/client-material.json','ADMIN_PASSWORD='+password,'RELAY_TOKEN='+random(),'VAULT_KEY='+random(),''];
fs.writeFileSync(envFile,lines.join('\n'),{flag:'wx',mode:0o600});
fs.writeFileSync(loginFile,'百炼中转工作台\n本地地址：http://127.0.0.1:3480\n账号：admin\n初始密码：'+password+'\n\n初始密码只在首次创建数据库时生效。后续在工作台修改密码。\n公网部署前设置 .env 的 PUBLIC_URL 和 PUBLIC_HOST，并启用 HTTPS。\n中转令牌可在登录后复制。请将此文件移入密码管理器后删除。\n',{flag:'wx',mode:0o600});
console.log('初始化完成，已生成 .env 和 管理员登录.txt。凭据未输出到终端。');
