import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
const dir=path.resolve(process.argv[2]),port=Number(process.argv[3] || 0);
const server=createServer(async(req,res)=>{if(req.url!=='/' && req.url!=='/preview.html'){res.writeHead(404);res.end();return;}try{res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Content-Security-Policy':"default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'"});res.end(await readFile(path.join(dir,'preview.html')));}catch{res.writeHead(500);res.end('Preview unavailable');}});
server.listen(port,'127.0.0.1',()=>console.log(`http://127.0.0.1:${server.address().port}/`));
