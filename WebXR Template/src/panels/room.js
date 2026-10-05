import * as THREE from 'three';

export class RoomGeometry {
  constructor(collision,scene=null){this.collision=collision;this.scene=scene;this.records=new Map();this.state='unavailable';this.session=null;this.serial=0;
    this.depthMaterial=new THREE.MeshBasicMaterial({colorWrite:false,depthWrite:true,depthTest:true,side:THREE.DoubleSide});
  }
  start(session,mr){this.stop();this.session=session;this.mr=mr;this.state=mr?'waiting for room data':'unavailable';}
  remove(record){this.collision.unregister(record.id);record.mesh?.removeFromParent();record.mesh?.geometry.dispose();}
  stop(){for(const r of this.records.values())this.remove(r);this.records.clear();this.session=null;this.state='unavailable';}
  dispose(){this.stop();this.depthMaterial.dispose();}
  get canScan(){return this.mr&&typeof this.session?.initiateRoomCapture==='function';}
  async scan(){if(!this.canScan)return false;try{await this.session.initiateRoomCapture();return true;}catch{return false;}}
  reset(){for(const r of this.records.values())this.remove(r);this.records.clear();if(this.mr)this.state='waiting for room data';}
  update(frame,space){
    if(!this.mr||!frame||!space)return;
    if(!frame.getViewerPose(space)){this.state='tracking interrupted';return;}
    const planes=frame.detectedPlanes,meshes=frame.detectedMeshes;
    if(planes===undefined&&meshes===undefined){this.state='unavailable';return;}
    const seen=new Set(),sources=[...[...(planes||[])].map(x=>[x,'plane']),...[...(meshes||[])].map(x=>[x,'mesh'])];
    let missing=false;
    for(const [source,kind] of sources){seen.add(source);let record=this.records.get(source);if(!record){record={id:`@room-${++this.serial}`,time:null};this.records.set(source,record);}
      const pose=frame.getPose(kind==='plane'?source.planeSpace:source.meshSpace,space);
      if(!pose){missing=true;continue;}
      const changed=record.time!==source.lastChangedTime||!record.local;
      if(changed){
        record.local=[];
        if(kind==='plane'){
          const points=source.polygon.map(p=>new THREE.Vector2(p.x,p.z));
          const indices=THREE.ShapeUtils.triangulateShape(points,[]);
          for(const index of indices)record.local.push(new THREE.Triangle(...index.map(i=>new THREE.Vector3(points[i].x,0,points[i].y))));
        }else for(let i=0;i<source.indices.length;i+=3){const ids=source.indices.slice(i,i+3);if(ids.length===3)record.local.push(new THREE.Triangle(...Array.from(ids,id=>new THREE.Vector3().fromArray(source.vertices,id*3))));}
        record.time=source.lastChangedTime;
        if(this.scene){
          const vertices=record.local.flatMap(t=>[...t.a.toArray(),...t.b.toArray(),...t.c.toArray()]);
          const geometry=new THREE.BufferGeometry();geometry.setAttribute('position',new THREE.Float32BufferAttribute(vertices,3));
          if(record.mesh){record.mesh.geometry.dispose();record.mesh.geometry=geometry;}
          else{record.mesh=new THREE.Mesh(geometry,this.depthMaterial);record.mesh.name='Detected room depth';record.mesh.matrixAutoUpdate=false;record.mesh.renderOrder=-1000;this.scene.add(record.mesh);}
        }
      }
      const matrix=new THREE.Matrix4().fromArray(pose.transform.matrix);
      if(record.mesh){record.mesh.matrix.copy(matrix);record.mesh.matrixWorldNeedsUpdate=true;}
      if(changed||!record.matrix?.equals(matrix)){this.collision.registerTriangles(record.id,record.local.map(t=>new THREE.Triangle(t.a.clone().applyMatrix4(matrix),t.b.clone().applyMatrix4(matrix),t.c.clone().applyMatrix4(matrix))));record.matrix=matrix;}
    }
    for(const [source,record] of this.records)if(!seen.has(source)){this.remove(record);this.records.delete(source);}
    this.state=missing?'tracking interrupted':this.records.size?'active':'waiting for room data';
  }
}
