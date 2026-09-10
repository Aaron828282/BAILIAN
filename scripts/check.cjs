'use strict';
const fs=require('node:fs'),path=require('node:path'),{spawnSync}=require('node:child_process');
let count=0;
for(const dir of ['src','public','scripts','test']){
 for(const item of fs.readdirSync(dir)){if(!/\.(cjs|js)$/.test(item))continue;const result=spawnSync(process.execPath,['--check',path.join(dir,item)],{stdio:'inherit'});if(result.status)process.exit(result.status);count++;}
}
const {readMaterial}=require('../src/key-package.cjs');
readMaterial('resources/client-material.json');
console.log('语法检查通过：'+count+' 个脚本；客户解包材料可读取。');
