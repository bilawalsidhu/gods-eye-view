import * as THREE from 'three';


export function createPanelView(brand,logo,maxTextureSize=4096,{variant='panel'}={}){
  const canvas=document.createElement('canvas'),ctx=canvas.getContext('2d');
  const font=(size,bold=false,display=false)=>`${bold?700:400} ${size}px "${display?brand.fonts.display.family:brand.fonts.body.family}"`;
  const metrics={measure(text,size,display,bold){ctx.font=font(size,bold||display,display);return ctx.measureText(text).width;},glyphHeight(size){ctx.font=font(size);const m=ctx.measureText('Hg');return m.actualBoundingBoxAscent+m.actualBoundingBoxDescent;}};
  let texture=new THREE.CanvasTexture(canvas);texture.colorSpace=THREE.SRGBColorSpace;
  // A label annotates an object the learner can walk around, so it stays readable from
  // behind. A panel faces its reader and culls the back.
  const material=new THREE.MeshBasicMaterial({map:texture,transparent:true,depthWrite:false,depthTest:true,toneMapped:false,side:variant==='label'?THREE.DoubleSide:THREE.FrontSide});
  const group=new THREE.Group(),face=new THREE.Mesh(new THREE.PlaneGeometry(1,1),material);group.add(face);
  const shape=new THREE.Shape();shape.moveTo(-.5,0);shape.absarc(-.47,0,.03,Math.PI/2,Math.PI*1.5,false);shape.lineTo(.47,-.03);shape.absarc(.47,0,.03,-Math.PI/2,Math.PI/2,false);shape.closePath();
  const handle=new THREE.Mesh(new THREE.ShapeGeometry(shape),new THREE.MeshBasicMaterial({color:'#ffffff',transparent:true,toneMapped:false,depthTest:true,depthWrite:false}));group.add(handle);
  const images=new Map();let dirty=true;
  const imageFor=src=>{let image=images.get(src);if(!image){image=new Image();image.onload=()=>{dirty=true;};image.onerror=()=>{dirty=true;};image.src=src;images.set(src,image);}return image;};
  function paint(panel){
    const l=panel.layout,page=l.pages[panel.page],c=brand.colors;
    // Supersample harder than the old 2x cap: a headset resolves glyph edges poorly off-axis,
    // and the extra texture is cheap next to an illegible panel. Still bounded by the GPU.
    const ratio=Math.min(3,maxTextureSize/l.width,maxTextureSize/l.height,4096/l.width,4096/l.height);
    const w=Math.ceil(l.width*ratio),h=Math.ceil(l.height*ratio);
    if(canvas.width!==w||canvas.height!==h){
      // WebGL2 texture storage is immutable after the first upload. A different canvas
      // size needs a fresh texture, otherwise old content is stretched over the new mesh.
      texture.dispose();canvas.width=w;canvas.height=h;
      texture=new THREE.CanvasTexture(canvas);texture.colorSpace=THREE.SRGBColorSpace;material.map=texture;
    }
    ctx.setTransform(ratio,0,0,ratio,0,0);ctx.clearRect(0,0,l.width,l.height);
    const box=(x,y,w,h,r,fill,stroke,width=1)=>{ctx.beginPath();ctx.roundRect(x,y,w,h,r);if(fill){ctx.fillStyle=fill;ctx.fill();}if(stroke){ctx.strokeStyle=stroke;ctx.lineWidth=width;ctx.stroke();}};
    const text=(s,x,y,size=24,color=c.text,bold=false,display=false)=>{ctx.fillStyle=color;ctx.font=font(size,bold,display);ctx.textBaseline='top';ctx.fillText(s,x,y);};
    const centeredText=(s,x,y,size=24,color=c.text,bold=false,display=false)=>{ctx.fillStyle=color;ctx.font=font(size,bold,display);ctx.textAlign='center';ctx.textBaseline='middle';ctx.fillText(s,x,y);ctx.textAlign='start';ctx.textBaseline='top';};
    const solid=panel.appearance==='solid';
    const shell=ctx.createLinearGradient(0,0,l.width*.35,l.height);shell.addColorStop(0,c.surface);shell.addColorStop(.48,c.background);shell.addColorStop(1,c.background);
    const outer=l.outerRadius,inset=outer-2,card=l.cardRadius,controlRadius=l.controlRadius;
    // One painted shell prevents the old solid backplate from peeking out around a translucent face.
    ctx.globalAlpha=solid?1:.88;box(1,1,l.width-2,l.height-2,outer,shell);ctx.globalAlpha=solid?1:.72;
    box(1.5,1.5,l.width-3,l.height-3,outer-.5,null,c.border,1.25);ctx.globalAlpha=1;
    // A light-catching upper face gives depth without a second, offset panel edge.
    const sheen=ctx.createLinearGradient(0,1,0,l.height*.48);sheen.addColorStop(0,'rgba(255,255,255,.22)');sheen.addColorStop(.23,'rgba(255,255,255,.055)');sheen.addColorStop(1,'rgba(255,255,255,0)');
    box(2,2,l.width-4,l.height-4,inset-1,sheen);
    if(variant==='label'){
      for(const item of page.items){
        if(item.type==='text'){
          const color=item.section?c.muted:c.text;
          if(item.align==='center')centeredText(item.text,l.width/2,item.y+item.height/2,item.size,color,item.bold);
          else text(item.text,item.x,item.y,item.size,color,item.bold);
        }
        if(item.type==='image'){
          const image=imageFor(item.src);
          if(image.naturalWidth){const scale=Math.min(item.width/image.naturalWidth,item.height/image.naturalHeight),iw=image.naturalWidth*scale,ih=image.naturalHeight*scale;ctx.drawImage(image,item.align==='center'?(l.width-iw)/2:item.x,item.y,iw,ih);}
          else text(item.alt,item.x,item.y,20,c.muted);
        }
      }
      texture.needsUpdate=true;dirty=false;return;
    }
    let y=30;
    if(logo?.naturalWidth){const lh=28,lw=lh*logo.naturalWidth/logo.naturalHeight;ctx.drawImage(logo,32,y,lw,lh);}else text(brand.name,32,y,20,c.muted,true);
    const optionsX=l.width-160,optionsY=22,optionsWidth=128,optionsHeight=42;
    box(optionsX,optionsY,optionsWidth,optionsHeight,controlRadius,c.surface,c.border);
    centeredText('Options',optionsX+optionsWidth/2,optionsY+optionsHeight/2,20,c.text);
    y=88;if(panel.content.eyebrow){text(panel.content.eyebrow,32,y,20,c.muted,true);y+=32;}
    for(const line of l.titleLines){text(line,32,y,36,c.text,true,true);y+=44;}
    for(const line of l.description){text(line,32,y,24,c.muted);y+=34;}
    if(page.bodyHeight>30)for(let col=0;col<l.columns;col++){
      const height=page.columnHeights?.[col]||0;if(height<=40)continue;
      const x=32+(col?l.colWidths[0]+24:0);
      box(x,l.headingHeight,l.colWidths[col],height,card,c.surface);
      ctx.globalAlpha=.36;box(x+.5,l.headingHeight+.5,l.colWidths[col]-1,height-1,card-.5,null,c.border);ctx.globalAlpha=1;
    }
    for(const item of page.items){
      if(item.type==='text')text(item.text,item.x,item.y,item.size,item.section?c.muted:c.text,item.bold);
      if(item.type==='progress'){box(item.x,item.y+5,item.width,8,4,c.background);box(item.x,item.y+5,item.width*Math.max(0,Math.min(1,item.value/Math.max(1,item.max))),8,4,c.accent);}
      if(item.type==='image'){
        const image=imageFor(item.src);
        if(image.naturalWidth){const scale=Math.min(item.width/image.naturalWidth,item.height/image.naturalHeight);ctx.drawImage(image,item.x,item.y,image.naturalWidth*scale,image.naturalHeight*scale);}else text(item.alt,item.x,item.y,20,c.muted);
      }
    }
    for(const control of page.controls){
      const enabled=control.enabled&&!(control.id==='@previous'&&panel.page===0)&&!(control.id==='@next'&&panel.page===l.pages.length-1);
      const active=enabled&&panel.hover===control.id,selected=control.selected,pressed=enabled&&panel.pressed===control.id;
      const fill=ctx.createLinearGradient(0,control.y,0,control.y+control.height);
      fill.addColorStop(0,control.primary?c.accent:c.surface);fill.addColorStop(1,control.primary?c.accent:c.background);
      box(control.x,control.y,control.width,control.height,controlRadius,fill,selected?c.accent:c.border);
      if(active||pressed||selected)box(control.x+1,control.y+1,control.width-2,control.height-2,controlRadius-1,pressed?'rgba(0,0,0,.16)':selected?'rgba(255,255,255,.08)':'rgba(255,255,255,.04)');
      ctx.globalAlpha=enabled?1:.5;
      const lines=control.lines,start=control.y+(control.height-lines.length*32)/2;
      for(let i=0;i<lines.length;i++)text(`${selected&&i===0?'✓ ':''}${lines[i]}`,control.x+24,start+i*32+(pressed?2:0),24,control.primary?c.accentText:c.text,true);
      ctx.globalAlpha=1;
    }
    const footerY=l.height-32-l.footerLines.length*28;
    l.footerLines.forEach((line,i)=>text(line,32,footerY+i*28,20,c.muted));
    if(l.pages.length>1)text(`${panel.page+1} / ${l.pages.length}`,l.width/2-28,footerY-52,20,c.muted);
    else text(panel.state==='placed'?({anchored:'World anchored',following:'Following',movable:'Placed'}[panel.mode]):({held:'Moving',following:'Following',blocked:'Waiting for space',recovering:'Repositioning'}[panel.state]||panel.state),32,footerY-48,20,c.muted);
    texture.needsUpdate=true;dirty=false;
  }
  return {group,face,handle,metrics,paint,get dirty(){return dirty;},resize(layout){
    face.scale.set(layout.physicalWidth,layout.physicalHeight,1);handle.position.set(0,-layout.physicalHeight/2-.034,0);handle.scale.set(layout.physicalWidth*.19,.28,1);},dispose(){for(const i of images.values()){i.onload=null;i.onerror=null;}face.geometry.dispose();handle.geometry.dispose();material.dispose();handle.material.dispose();texture.dispose();group.removeFromParent();}};
}
