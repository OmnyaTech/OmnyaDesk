// Original, project-authored tilemap geometry and avatar palette. No third-party art assets.
export const OFFICE_WIDTH=1600;
export const OFFICE_HEIGHT=980;
export const TILE_SIZE=40;
export const CAMERA_ZOOM_MIN=.65, CAMERA_ZOOM_MAX=1.65;
export const ROLES=Object.freeze([
 {id:'architect',name:'Arquiteto',station:'Arquitetura',x:426,y:313,color:0x5388e7,hair:0x253a55},
 {id:'developer',name:'Desenvolvedor',station:'Desenvolvimento',x:1164,y:313,color:0x43b794,hair:0x4d352c},
 {id:'qa',name:'QA',station:'Qualidade',x:426,y:745,color:0xb58ce4,hair:0x53354a},
 {id:'reviewer',name:'Revisor',station:'Revisão',x:1164,y:745,color:0xe2a96d,hair:0x2e293f}
]);
export const clampZoom=value=>Math.max(CAMERA_ZOOM_MIN,Math.min(CAMERA_ZOOM_MAX,value));
export const focusPoint=id=>{const role=ROLES.find(item=>item.id===id);return role?{x:role.x,y:role.y}:null;};
