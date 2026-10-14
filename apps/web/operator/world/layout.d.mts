export interface OfficeRole{
 readonly id:'architect'|'developer'|'qa'|'reviewer';
 readonly name:string;
 readonly station:string;
 readonly x:number;
 readonly y:number;
 readonly color:number;
 readonly hair:number;
}
export const OFFICE_WIDTH:number;
export const OFFICE_HEIGHT:number;
export const TILE_SIZE:number;
export const CAMERA_ZOOM_MIN:number;
export const CAMERA_ZOOM_MAX:number;
export const ROLES:readonly OfficeRole[];
export function clampZoom(value:number):number;
export function focusPoint(id:string):{x:number;y:number}|null;
