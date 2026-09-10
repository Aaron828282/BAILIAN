'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {DatabaseSync,backup}=require('node:sqlite');
(async()=>{
  process.umask(0o077);
  const dataDir=path.resolve(process.env.DATA_DIR||'data'),source=path.join(dataDir,'relay.sqlite');
  if(!fs.existsSync(source))throw Error('未找到数据库');
  const dir=path.join(dataDir,'backups');fs.mkdirSync(dir,{recursive:true,mode:0o700});
  const destination=path.join(dir,'relay-'+new Date().toISOString().replace(/[:.]/g,'-')+'-'+crypto.randomBytes(3).toString('hex')+'.sqlite');
  const db=new DatabaseSync(source,{readOnly:true});
  try{await backup(db,destination);}finally{db.close();}
  console.log('一致性快照已保存：'+destination);
})().catch(e=>{console.error('备份失败：'+(e.code||e.message));process.exitCode=1;});
