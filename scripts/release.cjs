'use strict';
// 只复制发布白名单；运行数据、登录凭据、测试截图和真实 API Key 不进入发布目录。
const fs=require('node:fs'),path=require('node:path');
const root=path.resolve(__dirname,'..'),version=JSON.parse(fs.readFileSync(path.join(root,'package.json'))).version;
const target=path.join(root,'dist','bailian-relay-workbench-'+version);
if(fs.existsSync(target)){console.error('发布目录已存在，请使用新的版本号或先人工归档该目录。');process.exit(1);}
fs.mkdirSync(target,{recursive:true});
const list=['package.json','README.md','Dockerfile','compose.yaml','.dockerignore','.gitignore','src','public','vendor','resources','scripts','deploy','docs','test'];
for(const name of list)fs.cpSync(path.join(root,name),path.join(target,name),{recursive:true});
console.log('发布目录已生成：'+target);
