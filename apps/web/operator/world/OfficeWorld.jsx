import Phaser from 'phaser';
import './world.css';
import './projection.css';
import {useEffect,useRef,useState} from 'react';

import {OFFICE_WIDTH,OFFICE_HEIGHT,TILE_SIZE,ROLES,clampZoom,focusPoint} from './layout.mjs';
import {projectOffice} from './projector.mjs';

function drawPerson(scene,role){
 const texture='s21-avatar-'+role.id;
 if(!scene.textures.exists(texture)){
  const sprite=scene.make.graphics({x:0,y:0},false);
  const rect=(color,x,y,w,h)=>sprite.fillStyle(color,1).fillRect(x,y,w,h);
  rect(0x1c283d,12,55,7,5);rect(0x1c283d,24,55,7,5);
  rect(0x27384a,12,42,20,14);
  rect(role.color,7,26,30,20);
  rect(0x1c2b3b,6,43,33,4);
  rect(0xdda783,13,8,19,20);
  rect(role.hair,10,5,25,9);
  rect(role.hair,10,9,5,10);
  rect(0x29384a,17,18,3,3);rect(0x29384a,27,18,3,3);
  rect(0xc88972,14,27,6,5);rect(0xc88972,27,27,6,5);
  rect(0x132437,10,44,11,4);rect(0x132437,24,44,11,4);
  sprite.generateTexture(texture,44,64);sprite.destroy();
 }
 return scene.add.image(role.x+114,role.y+68,texture).setOrigin(.5,.8).setDepth(8);
}

function drawStation(scene,role){
 const g=scene.add.graphics().setDepth(3);
 const x=role.x,y=role.y;
 g.fillStyle(0x1a344a,1).fillRoundedRect(x-172,y-149,354,288,22);
 g.lineStyle(3,0x2e5b79,.9).strokeRoundedRect(x-172,y-149,354,288,22);
 g.fillStyle(0x15273a,.8).fillRoundedRect(x-158,y-135,328,258,15);
 g.lineStyle(1,0x38536d,.6).strokeRoundedRect(x-158,y-135,328,258,15);
 // Cabinet and desk: deliberately stationary; S22 owns activity animation.
 g.fillStyle(0x3a536b).fillRect(x-77,y-28,194,22);
 g.fillStyle(0x9a6b52).fillRect(x-90,y-13,222,42);
 g.fillStyle(0x624a42).fillRect(x-83,y+28,20,27);
 g.fillStyle(0x624a42).fillRect(x+97,y+28,20,27);
 g.fillStyle(0x1a2c3f).fillRoundedRect(x-20,y-82,94,69,7);
 g.lineStyle(6,0x4b6e88).strokeRoundedRect(x-20,y-82,94,69,7);
 g.fillStyle(0x224969).fillRect(x-12,y-74,78,49);
 g.fillStyle(0x6091b7).fillRect(x-5,y-67,45,5);
 g.fillStyle(0x3b698d).fillRect(x-5,y-56,58,4);
 g.fillStyle(0x386085).fillRect(x-5,y-46,28,4);
 g.fillStyle(0x405167).fillRect(x+23,y-13,8,10);
 g.fillStyle(0x31465a).fillRoundedRect(x-30,y+42,65,29,9);
 g.fillStyle(0x7fa6b7,.65).fillRect(x-66,y+6,53,8);
 scene.add.text(x-144,y-121,role.station.toUpperCase(),{
  fontFamily:'Consolas,monospace',fontSize:'20px',fontStyle:'bold',color:'#b5d8ec',
  resolution:2
 }).setDepth(10);
 scene.add.text(x-129,y+105,role.name,{
  fontFamily:'Arial,sans-serif',fontSize:'17px',color:'#dceaf6',
  backgroundColor:'#153044',padding:{left:9,right:9,top:5,bottom:5},resolution:2
 }).setDepth(10);
 const avatar=drawPerson(scene,role);
 const indicator=scene.add.text(x-133,y+68,'Sem atividade registrada',{
  fontFamily:'Consolas,monospace',fontSize:'13px',color:'#92aabf',
  backgroundColor:'#172c3f',padding:{left:7,right:7,top:4,bottom:4},resolution:2
 }).setDepth(12);
 return {avatar,indicator,role,lastPhase:'idle',lastTask:null,tween:null,baseY:avatar.y};
}

export class OfficeScene extends Phaser.Scene{
 constructor(onReady,onInspect,overview=false){super({key:'OmnyaOffice'});this.onReady=onReady;this.onInspect=onInspect;this.overview=overview;this.keys=null;this.stationSprites=new Map();this.currentProjection=null;}
 create(){
  // Project-owned procedural tileset. No remote assets or unlicensed art.
  const tileKey='s21-floor-tiles';
  if(!this.textures.exists(tileKey)){
   const paint=this.make.graphics({x:0,y:0},false);
   for(let i=0;i<2;i++){
    paint.fillStyle(i?0x193047:0x1b344a).fillRect(i*TILE_SIZE,0,TILE_SIZE,TILE_SIZE);
    paint.lineStyle(1,0x2c4a62,.7).strokeRect(i*TILE_SIZE,0,TILE_SIZE,TILE_SIZE);
    paint.fillStyle(0x315068,.36).fillRect(i*TILE_SIZE+6,6,5,5);
   }
   paint.generateTexture(tileKey,TILE_SIZE*2,TILE_SIZE);
   paint.destroy();
  }
  const rows=Math.ceil(OFFICE_HEIGHT/TILE_SIZE),cols=OFFICE_WIDTH/TILE_SIZE;
  const data=Array.from({length:rows},(_,row)=>Array.from({length:cols},(_,col)=>(row+col)%2));
  const map=this.make.tilemap({data,tileWidth:TILE_SIZE,tileHeight:TILE_SIZE});
  const tileset=map.addTilesetImage(tileKey,tileKey,TILE_SIZE,TILE_SIZE,0,0);
  if(!tileset)throw Error('S21 owned tileset initialization failed');
  const layer=map.createLayer(0,tileset,0,0);
  if(!layer)throw Error('S21 tilemap layer initialization failed');
  const g=this.add.graphics();
  g.lineStyle(14,0x2f4c66).strokeRect(16,16,OFFICE_WIDTH-32,OFFICE_HEIGHT-32);
  g.lineStyle(5,0x597b90).strokeRect(27,27,OFFICE_WIDTH-54,OFFICE_HEIGHT-54);
  // Wide corridors and four distinct workstations.
  g.fillStyle(0x10283c,.75).fillRoundedRect(734,112,132,755,28);
  g.lineStyle(2,0x40647f,.7).strokeRoundedRect(734,112,132,755,28);
  g.fillStyle(0x22445c).fillRoundedRect(120,476,1360,62,18);
  g.lineStyle(2,0x50788d).strokeRoundedRect(120,476,1360,62,18);
  for(const x of [200,520,1080,1400]){
   g.fillStyle(0x315977,.9).fillRect(x,27,120,18);
   g.fillStyle(0x6ca5bf).fillRect(x+9,29,102,9);
  }
  for(const role of ROLES){
   const entry=drawStation(this,role);
   entry.avatar.setInteractive({useHandCursor:true}).on('pointerup',()=>{
    if(this.currentProjection?.connected)this.onInspect?.(role.id);
   });
   this.stationSprites.set(role.id,entry);
  }
  this.cameras.main.setBounds(0,0,OFFICE_WIDTH,OFFICE_HEIGHT);
  this.cameras.main.centerOn(OFFICE_WIDTH/2,OFFICE_HEIGHT/2);
  this.cameras.main.setRoundPixels(true);
  if(this.overview)this.cameras.main.setZoom(.46);
  this.keys=this.input.keyboard?.addKeys('W,A,S,D,UP,DOWN,LEFT,RIGHT');
  let dragging=false,oldX=0,oldY=0;
  this.input.on('pointerdown',pointer=>{dragging=true;oldX=pointer.x;oldY=pointer.y;});
  this.input.on('pointerup',()=>{dragging=false;});
  this.input.on('gameout',()=>{dragging=false;});
  this.input.on('pointermove',pointer=>{
   if(!dragging||!pointer.isDown)return;
   const camera=this.cameras.main;
   camera.scrollX-=(pointer.x-oldX)/camera.zoom;
   camera.scrollY-=(pointer.y-oldY)/camera.zoom;
   oldX=pointer.x;oldY=pointer.y;
  });
  this.input.on('wheel',(_pointer,_objects,_dx,deltaY)=>{
   this.setZoom(this.cameras.main.zoom+(deltaY>0?-.1:.1));
  });
  this.onReady(this);
 }
 applyProjection(projection){
  this.currentProjection=projection;
  for(const value of projection.roles){
   const entry=this.stationSprites.get(value.id);
   if(!entry)continue;
   const active=value.phase==='working',waiting=value.phase==='waiting';
   const label=active?'Ativa • '+value.total+' tarefa(s)':waiting?'Revisão humana pendente':
    value.phase==='paused'?'Dados sem conexão':'Sem atividade registrada';
   entry.indicator.setText(label);
   entry.indicator.setColor(active?'#8de0bd':waiting?'#f7d19b':'#92aabf');
   entry.indicator.setAlpha(value.phase==='paused'?.65:1);
   entry.avatar.setAlpha(value.phase==='paused'?.55:1);
   if(entry.lastPhase===value.phase&&entry.lastTask===value.taskId)continue;
   entry.tween?.stop();entry.tween=null;
   entry.avatar.y=entry.baseY;
   if(active)entry.tween=this.tweens.add({targets:entry.avatar,y:entry.baseY-5,
    duration:480,yoyo:true,repeat:-1,ease:'Sine.inOut'});
   entry.lastPhase=value.phase;entry.lastTask=value.taskId;
  }
 }
 update(_time,delta){
  if(!this.keys)return;
  const pressed=name=>this.keys[name]?.isDown;
  const dx=Number(pressed('D')||pressed('RIGHT'))-Number(pressed('A')||pressed('LEFT'));
  const dy=Number(pressed('S')||pressed('DOWN'))-Number(pressed('W')||pressed('UP'));
  if(dx||dy)this.pan(dx*delta*.52,dy*delta*.52);
 }
 pan(x,y){this.cameras.main.scrollX+=x/this.cameras.main.zoom;this.cameras.main.scrollY+=y/this.cameras.main.zoom;}
 setZoom(value){
  const camera=this.cameras.main,x=camera.midPoint.x,y=camera.midPoint.y;
  camera.setZoom(this.overview?Math.max(.4,Math.min(1.65,value)):clampZoom(value));camera.centerOn(x,y);
  return camera.zoom;
 }
 focusRole(id){
  const point=focusPoint(id);
  if(point)this.cameras.main.centerOn(point.x,point.y);
 }
 reset(){this.cameras.main.setZoom(this.overview?.46:1);this.cameras.main.centerOn(800,490);}
}

export function OfficeWorld({projectId,tasks=[],events=[],historyComplete=true,connection='offline',onInspectTask,overview=false}){
 const host=useRef(null),scene=useRef(null),game=useRef(null),inspectRef=useRef(onInspectTask);
 inspectRef.current=onInspectTask;
 const [ready,setReady]=useState(false),[zoom,setZoom]=useState(overview?.46:1);
 const projection=projectOffice({projectId,tasks,events,historyComplete,connection});
 useEffect(()=>{
  if(!host.current)return;
  let alive=true;
  const office=new OfficeScene(active=>{if(!alive)return;scene.current=active;setReady(true);},roleId=>{
   const role=scene.current?.currentProjection?.roles.find(item=>item.id===roleId);
   if(role?.taskId)inspectRef.current?.(role.taskId);
  },overview);
  const instance=new Phaser.Game({type:Phaser.CANVAS,
   parent:host.current,width:940,height:450,transparent:false,
   backgroundColor:'#14273a',
   render:{pixelArt:true,antialias:false},
   fps:{target:24,min:10,forceSetTimeOut:true}, // S25: idle budget; state animations remain canonical.
   scale:{mode:Phaser.Scale.FIT,autoCenter:Phaser.Scale.CENTER_BOTH,width:940,height:450},
   scene:[office],input:{mouse:{preventDefaultWheel:true}}});
  game.current=instance;
  // Hidden/minimized window consumes no Phaser scene updates; backend state still reloads on restore.
  const visibility=()=>{
   if(document.hidden)instance.scene.pause('OmnyaOffice');
   else instance.scene.resume('OmnyaOffice');
  };
  document.addEventListener('visibilitychange',visibility);
  return()=>{document.removeEventListener('visibilitychange',visibility);
   alive=false;scene.current=null;game.current=null;instance.destroy(true);};
 },[]);
 useEffect(()=>{if(ready)scene.current?.applyProjection(projection);},[ready,projectId,tasks,events,historyComplete,connection]);
 const applyZoom=delta=>{
  if(scene.current)setZoom(scene.current.setZoom(scene.current.cameras.main.zoom+delta));
 };
 const nav=(x,y)=>scene.current?.pan(x,y);
 return <section className="surface world-surface" id="world" aria-label="Escritório virtual 2D">
  <div className="surface-heading world-heading">
   <div><span className="eyebrow">AMBIENTE VIRTUAL / S21</span><h2>Escritório 2D <span className="count">4 estações</span></h2></div>
   <span className="world-state" role="status">{!ready?'Carregando mapa…':!projection.connected?'Sem conexão ativa': 'Mapa navegável'}</span>
  </div>
  <div className="world-view" ref={host} data-office-map="phaser" tabIndex={0}
   aria-label="Mapa Phaser, quatro estações de trabalho. Use setas ou WASD para mover a câmera, ou os botões abaixo."
  />
  <div className="world-toolbar">
   <div className="world-role-nav" role="group" aria-label="Centralizar a câmera na estação">
    {ROLES.map(role=><button type="button" key={role.id} disabled={!ready}
     onClick={()=>scene.current?.focusRole(role.id)}>{role.station}</button>)}
   </div>
   <div className="world-controls" role="group" aria-label="Controles da câmera">
    <button onClick={()=>nav(0,-140)} disabled={!ready} aria-label="Mover câmera para cima">↑</button>
    <button onClick={()=>nav(-170,0)} disabled={!ready} aria-label="Mover câmera para esquerda">←</button>
    <button onClick={()=>nav(170,0)} disabled={!ready} aria-label="Mover câmera para direita">→</button>
    <button onClick={()=>nav(0,140)} disabled={!ready} aria-label="Mover câmera para baixo">↓</button>
    <button onClick={()=>applyZoom(-.15)} disabled={!ready} aria-label="Reduzir zoom">−</button>
    <span aria-label="Nível do zoom">{Math.round(zoom*100)}%</span>
    <button onClick={()=>applyZoom(.15)} disabled={!ready} aria-label="Ampliar zoom">+</button>
    <button onClick={()=>{scene.current?.reset();setZoom(overview?.46:1);}} disabled={!ready}>Centralizar</button>
   </div>
  </div>
  <div className="world-roles" aria-label="Estado persistido por estação" role="list">
   {projection.roles.map(role=><div key={role.id} role="listitem" className={'world-role world-role--'+role.phase}>
    <strong>{role.name}</strong>
    {role.taskId&&<button type="button" className="world-inspect" onClick={()=>onInspectTask?.(role.taskId)}>Inspecionar tarefa e logs</button>}
    <span>{role.phase==='working'?'Em execução — '+role.total+' tarefa(s)':role.phase==='waiting'?'Aguardando aprovação humana':role.phase==='paused'?'Sem atualização em tempo real':'Sem atividade registrada'}</span>
   </div>)}
  </div>
  <p className="world-note" data-replay={projection.replay.lastSequence}>
   Dados: estados persistidos no projeto autorizado. Eventos ordenados e reconciliados após reconexão
   (até {projection.replay.applied} transições verificáveis; {projection.replay.complete?'histórico carregado':'histórico parcial'}).
   Quando desconectado, animações são suspensas; nenhuma atividade é simulada. Arraste, use WASD ou os controles da câmera.
  </p>
 </section>;
}
