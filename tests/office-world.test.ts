import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readFileSync} from 'node:fs';
import {ROLES,OFFICE_WIDTH,OFFICE_HEIGHT,TILE_SIZE,CAMERA_ZOOM_MIN,
 CAMERA_ZOOM_MAX,clampZoom,focusPoint} from '../apps/web/operator/world/layout.mjs';

test('S21 original tilemap is bounded and covers each coordinate',()=>{
 assert.equal(OFFICE_WIDTH%TILE_SIZE,0);assert.equal(OFFICE_HEIGHT%TILE_SIZE,20);
 assert.ok(OFFICE_WIDTH>=1200&&OFFICE_HEIGHT>=720);
});
test('S21 exactly four unique agents and four distinct stations',()=>{
 assert.deepEqual(ROLES.map(r=>r.id),['architect','developer','qa','reviewer']);
 assert.equal(new Set(ROLES.map(r=>r.station)).size,4);
 assert.equal(new Set(ROLES.map(r=>r.name)).size,4);
 assert.equal(new Set(ROLES.map(r=>r.color)).size,4);
});
test('S21 stations remain within map and separated by safe margins',()=>{
 for(const r of ROLES){
  assert.ok(r.x>200&&r.x<OFFICE_WIDTH-200);
  assert.ok(r.y>170&&r.y<OFFICE_HEIGHT-170);
  for(const other of ROLES.filter(v=>v.id!==r.id))
   assert.ok(Math.hypot(r.x-other.x,r.y-other.y)>370);
 }
});
test('S21 camera zoom respects numeric minimum and maximum',()=>{
 assert.equal(clampZoom(.1),CAMERA_ZOOM_MIN);
 assert.equal(clampZoom(5),CAMERA_ZOOM_MAX);
 assert.equal(clampZoom(1),1);
});
test('S21 keyboard focus lookup uses canonical station coordinates',()=>{
 for(const role of ROLES)assert.deepEqual(focusPoint(role.id),{x:role.x,y:role.y});
 assert.equal(focusPoint('forged-role'),null);
});
test('S21 Phaser world owns input navigation, original tilemap and canvas renderer',()=>{
 const source=readFileSync('apps/web/operator/world/OfficeWorld.jsx','utf8');
 assert.match(source,/new Phaser\.Game/);assert.match(source,/type:Phaser\.CANVAS/);
 assert.match(source,/Phaser\.Scale\.FIT/);assert.match(source,/this\.make\.tilemap/);assert.match(source,/map\.addTilesetImage/);
 assert.match(source,/map\.createLayer/);assert.match(source,/scene\.add\.graphics|this\.add\.graphics/);
 assert.match(source,/sprite\.generateTexture/);assert.match(source,/pointermove/);
 assert.match(source,/input\.keyboard/);assert.match(source,/this\.input\.on\('wheel'/);
});
test('S21 office never invents activity or carries authentication credentials',()=>{
 const source=readFileSync('apps/web/operator/world/OfficeWorld.jsx','utf8');
 for(const forbidden of ['fetch(','Bearer ','localStorage','sessionStorage','window.location','approved'])
  assert.equal(source.includes(forbidden),false,'Unexpected unsafe world dependency '+forbidden);
 assert.match(source,/S22/);assert.match(source,/estático/);
});
test('S21 operator menu includes navigable world and accessible camera controls',()=>{
 const app=readFileSync('apps/web/operator/app.jsx','utf8');
 const source=readFileSync('apps/web/operator/world/OfficeWorld.jsx','utf8');
 assert.match(app,/href="#world"/);assert.match(app,/<OfficeWorld\/>/);
 assert.match(source,/aria-label="Controles da câmera"/);
 assert.match(source,/aria-label="Centralizar a câmera na estação"/);
 assert.match(source,/aria-label="Escritório virtual 2D"/);
 assert.match(source,/zoom/);
});
