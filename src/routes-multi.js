'use strict';
const express=require('express');
const router=express.Router();
const QRCode=require('qrcode');
const SM=require('./session-manager');
function storeOf(req){return req.query.store||(req.body&&req.body.store)||process.env.STORE_ID||'default';}
router.get('/qr',async(req,res)=>{
    try{
          const store=storeOf(req);
          const s=await SM.getOrCreate(store);
          if(s.status==='connected')return res.json({status:'connected',store_id:store});
          if(!s.qr)return res.json({status:s.status,qr:null,store_id:store,message:'Generando QR, reintenta en 3s'});
          try{const qrImage=await QRCode.toDataURL(s.qr,{width:300});return res.json({status:'qr_ready',qr:qrImage,raw:s.qr,store_id:store});}
          catch(e){return res.json({status:'qr_ready',qr:null,raw:s.qr,store_id:store});}
        }catch(err){res.status(500).json({error:err.message});}
  });
router.get('/status',(req,res)=>{
    const store=storeOf(req);
    const s=SM.get(store)||{};
    res.json({status:s.status||'connecting',connectedPhone:s.sock&&s.sock.user?s.sock.user.id:null,hasQR:!!(s.qr),store_id:store,uptime:Math.floor(process.uptime()),timestamp:new Date().toISOString()});
  });
router.post('/connect',async(req,res)=>{
    try{const store=storeOf(req);const s=await SM.startSession(store);res.json({ok:true,store_id:store,status:s.status});}
    catch(err){res.status(500).json({error:err.message});}
  });
router.post('/disconnect',async(req,res)=>{
    try{const store=storeOf(req);await SM.stopSession(store);res.json({ok:true,store_id:store,status:'stopped'});}
    catch(err){res.status(500).json({error:err.message});}
  });
router.post('/send',async(req,res)=>{
    try{
          const store=storeOf(req);
          const s=SM.get(store);
          if(!s||!s.sock||s.status!=='connected')return res.status(409).json({error:'not_connected',store_id:store});
          const{jid,text,message}=req.body;
          const waJid=(jid||'').includes('@')?jid:(jid+'@s.whatsapp.net');
          const body=text||message;
          if(!waJid||!body)return res.status(400).json({error:'jid y text son requeridos'});
          const sent=await s.sock.sendMessage(waJid,{text:body});
          res.json({ok:true,messageId:sent.key.id,store_id:store});
        }catch(err){res.status(500).json({error:err.message});}
  });
router.get('/sessions',(req,res)=>{res.json({sessions:SM.listAll(),total:SM.sessions.size});});
router.get('/events',(req,res)=>{
    const sse=req.app.get('sse');
    if(!sse)return res.status(500).json({error:'SSE no disponible'});
    sse.addClient(req,res);
  });
module.exports=router;
