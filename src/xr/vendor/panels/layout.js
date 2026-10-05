// Renderer-independent measurements. Pixels, layout units and metres are deliberately separate.
// One radius scale keeps a dense panel from looking like unrelated stacked cards.
export const TOKENS = Object.freeze({padding:32, gap:24, controlGap:16, radius:24, cardRadius:16, controlRadius:14, body:24, small:20, title:36, button:24});
export const radians = degrees => degrees * Math.PI / 180;
export const spanAt = (distance, degrees) => 2 * distance * Math.tan(radians(degrees) / 2);

// The legibility floor, in degrees of visual angle. A standalone headset resolves far less
// detail than a monitor -- a Quest 3 is around 25 pixels per degree at the centre and less
// off-axis -- so body text below about 0.9 degrees turns to mush at arm's length even though
// it reads fine on a desktop preview. These are the minimums; content never gets smaller.
export const LEGIBILITY = Object.freeze({body:.85, secondary:.65});

// Metres per layout unit, fixed by that floor at the distance the surface is actually read
// from. Reading distance is the only parameter; the angular guarantee itself never moves.
export function unitFor(distance, metrics) {
  const glyph=metrics.glyphHeight?.(TOKENS.body) || TOKENS.body*.72;
  const smallGlyph=metrics.glyphHeight?.(TOKENS.small) || TOKENS.small*.72;
  return Math.max(spanAt(distance,LEGIBILITY.body)/glyph, spanAt(distance,LEGIBILITY.secondary)/smallGlyph);
}

export function wrapText(value, width, measure) {
  const lines=[];
  // A nonbreaking space keeps measurements together; oversized tokens still get split safely.
  const text=String(value??'').replace(/(\d)\s+(V|mrem\/hr|mrem|cm|mm|m|%|Hz|A|W)\b/g,'$1\u00a0$2');
  for(const paragraph of text.split('\n')) {
    let line='';
    for(const word of paragraph.split(/ +/)) {
      if(measure(line ? `${line} ${word}` : word)<=width) {line=line?`${line} ${word}`:word;continue;}
      if(line)lines.push(line);line='';
      for(const char of Array.from(word)) {if(line&&measure(line+char)>width){lines.push(line);line='';}line+=char;}
    }
    lines.push(line);
  }
  return lines;
}

export function layoutPanel(content, metrics, {maxWidth=44,maxHeight=32, widthLimit=Infinity, heightLimit=Infinity,minWidth=0,minHeight=0,distance=1.25}={}) {
  const measure=(s,size=TOKENS.body,display=false,bold=false)=>metrics.measure(String(s),size,display,bold);
  const unit=unitFor(distance,metrics);
  const dense=(content.blocks||[]).some(b=>b.column===1);
  const angularWidth=Math.min(maxWidth,dense?44:36);
  const limit=Math.min(spanAt(distance,angularWidth)/unit,widthLimit/unit);
  const labels=[content.title,...(content.actions||[]).map(a=>a.label),...(content.blocks||[]).flatMap(b=>[b.label,b.text])].filter(Boolean);
  const desired=dense?limit:Math.max(560,...labels.map(s=>Math.min(800,measure(s)+112)));
  const width=Math.max(240,Math.min(limit,Math.max(desired,minWidth/unit))), inner=width-64;
  const columns=dense&&inner>=620?2:1;
  const colWidths=columns===2?[(inner-24)*.55,(inner-24)*.45]:[inner];
  const titleLines=wrapText(content.title||'Information',inner,s=>measure(s,36,true));
  const description=content.description?wrapText(content.description,inner,s=>measure(s)):[];
  const headingHeight=88+(content.eyebrow?32:0)+titleLines.length*44+description.length*34+24;
  const footerLines=content.footer?wrapText(content.footer,inner,s=>measure(s,20)):[];
  const footerHeight=footerLines.length*28+(footerLines.length?24:0);
  const actions=(content.actions||[]).map(a=>({...a,enabled:a.enabled!==false}));
  const seen=new Set();for(const a of actions){if(!a.id||seen.has(a.id)||String(a.id).startsWith('@'))throw new Error('Panel actions need unique non-reserved IDs');seen.add(a.id);}
  const actionArea=columns===2?colWidths[0]:inner;
  const actionColumns=actionArea>=480?2:1;
  const actionWidth=(actionArea-(actionColumns-1)*16)/actionColumns;
  const actionRows=[];
  // Primary actions have a full row, the other actions pair up where space allows.
  for(let i=0;i<actions.length;){const first=actions[i++],row=[first];if(!first.primary&&actionColumns===2&&i<actions.length&&!actions[i].primary)row.push(actions[i++]);
    const w=row.length===1?actionArea:actionWidth;
    const cells=row.map(a=>({...a,lines:wrapText(a.label,w-48-(a.selected?24:0),s=>measure(s,24,false,true)),width:w}));
    actionRows.push({cells,height:Math.max(64,...cells.map(a=>a.lines.length*32+24))});
  }
  const maxH=Math.min(spanAt(distance,maxHeight)/unit,heightLimit/unit);
  // Reserve navigation even on a one-page panel, so live content cannot shift controls.
  const available=maxH-headingHeight-footerHeight-32-72;
  if(available<80)throw new Error('Panel heading/footer exceeds the readable viewport; shorten it or move details into body blocks');
  const primaryRows=actionRows.filter(r=>r.cells.some(a=>a.primary));
  const regularRows=actionRows.filter(r=>!r.cells.some(a=>a.primary));
  const allActionsH=actionRows.reduce((n,r)=>n+r.height+16,0);
  const primaryH=primaryRows.reduce((n,r)=>n+r.height+16,0);
  if(primaryH>available-40)throw new Error('Too many persistent primary actions');
  const persistent=allActionsH<=available*.55?actionRows:primaryRows;
  const persistentH=persistent.reduce((n,r)=>n+r.height+16,0);
  const bodyH=available-persistentH-(persistentH?24:0);
  const fragments=[[],[]];
  for(const block of content.blocks||[]) {
    const col=columns===2&&block.column===1?1:0,w=colWidths[col]-48;
    const pushText=(text,{small=false,bold=false,...extra}={})=>{const size=extra.reading?32:small?20:24;for(const line of wrapText(text,w,s=>measure(s,size)))fragments[col].push({type:'text',text:line,size,bold,height:extra.reading?44:small?32:34,...extra});};
    if(block.label)pushText(block.label,{small:true,bold:true,section:true});
    switch(block.type){
      case 'image': fragments[col].push({type:'image',src:block.src,alt:block.alt||'',height:Math.min(block.height||150,bodyH-24)});break;
      case 'list': case 'checklist': for(const item of block.items||[])pushText(typeof item==='string'?`• ${item}`:`${item.checked?'✓':'○'} ${item.label}`);break;
      case 'keyValue': for(const row of block.rows||[])pushText(`${row.label}: ${row.value}`);break;
      case 'progress': pushText(`${block.value} / ${block.max} ${block.text||''}`);fragments[col].push({type:'progress',value:block.value,max:block.max,height:24});break;
      default: pushText(block.text||'',{bold:block.type==='reading',reading:block.type==='reading'});
    }
    fragments[col].push({type:'space',height:16});
  }
  const pages=[];let indices=[0,0];
  do {const items=[];let used=0;const columnHeights=[];
    for(let col=0;col<columns;col++){let y=24;const capacity=col===1?available:bodyH;while(indices[col]<fragments[col].length){const f=fragments[col][indices[col]];if(y+f.height>capacity-8&&y>24)break;indices[col]++;items.push({...f,x:32+(col?colWidths[0]+24:0)+24,y:headingHeight+y,width:colWidths[col]-48,column:col});y+=f.height;}columnHeights.push(y+16);used=Math.max(used,y+16);}
    pages.push({items,bodyHeight:used,columnHeights,actions:persistent});
  }while(indices.some((n,i)=>i<columns&&n<fragments[i].length));
  if(persistent!==actionRows){let rows=[],height=0;for(const row of regularRows){if(height+row.height+16>bodyH&&rows.length){pages.push({items:[],bodyHeight:0,actions:[...rows,...primaryRows],actionPage:true});rows=[];height=0;}rows.push(row);height+=row.height+16;}if(rows.length)pages.push({items:[],bodyHeight:0,actions:[...rows,...primaryRows],actionPage:true});}
  const height=Math.min(maxH,Math.max(minHeight/unit,...pages.map(p=>headingHeight+Math.max((p.columnHeights?.[0]??p.bodyHeight)+(p.actions.length?24:0)+p.actions.reduce((n,r)=>n+r.height+16,0),p.columnHeights?.[1]||0)+footerHeight+32+72)));
  for(const page of pages){const controls=[];let y=height-footerHeight-32-72-page.actions.reduce((n,r)=>n+r.height+16,0);
    for(const row of page.actions){let x=32;for(const a of row.cells){controls.push({...a,x,y,height:row.height});x+=a.width+16;}y+=row.height+16;}
    if(pages.length>1){controls.push({id:'@previous',label:'Previous',lines:['Previous'],x:32,y:height-footerHeight-96,width:150,height:64,enabled:true},{id:'@next',label:'Next',lines:['Next'],x:width-182,y:height-footerHeight-96,width:150,height:64,enabled:true});}
    page.controls=controls;
  }
  return {width,height,unit,physicalWidth:width*unit,physicalHeight:height*unit,outerRadius:TOKENS.radius,cardRadius:TOKENS.cardRadius,controlRadius:TOKENS.controlRadius,headingHeight,titleLines,description,footerLines,pages,columns,colWidths};
}

export const LABEL_TOKENS = Object.freeze({padding:16, gap:8, radius:12, title:20, text:24});

// A label is an annotation on an object, not an information panel: no options button, no
// pagination reserve, no grab handle, and no minimum width.
//
// Two ways to size one. By default it keeps the same angular legibility rule as a panel,
// applied at the distance the annotation is read from, and shrinks to fit its text. Pass
// `size` (metres) instead when the label plates a feature of the model — a table rim, a
// tray, a badge — where the physical footprint is the fixed thing and the type has to fit
// it. Then the plate is exactly that size and the type scales to sit inside it.
export function layoutLabel(content, metrics, {distance=.45, maxWidth=36, widthLimit=Infinity, size=null}={}) {
  const measure=(s,size,bold=false)=>metrics.measure(String(s),size,false,bold);
  const {padding:pad,gap,radius,title:titleSize,text:textSize}=LABEL_TOKENS;
  const unit=unitFor(distance,metrics);
  const limit=Math.min(spanAt(distance,maxWidth)/unit,widthLimit/unit);
  const inner=Math.max(48,limit-pad*2);
  const titleLines=content.title?wrapText(content.title,inner,s=>measure(s,titleSize,true)):[];
  const textLines=content.text?wrapText(content.text,inner,s=>measure(s,textSize)):[];
  const image=content.image?{src:content.image.src,alt:content.image.alt||'',width:Math.min(inner,content.image.width||144),height:content.image.height||48}:null;
  const align=content.align==='center'?'center':'left';
  const widest=Math.max(0,image?image.width:0,...titleLines.map(s=>measure(s,titleSize,true)),...textLines.map(s=>measure(s,textSize)));
  const width=Math.max(48,Math.min(limit,Math.ceil(widest)+pad*2));
  const items=[];let y=pad;
  for(const line of titleLines){items.push({type:'text',text:line,x:pad,y,size:titleSize,bold:true,section:true,align,height:28});y+=28;}
  if(titleLines.length&&(textLines.length||image))y+=gap;
  for(const line of textLines){items.push({type:'text',text:line,x:pad,y,size:textSize,align,height:34});y+=34;}
  if(image){if(textLines.length)y+=gap;items.push({type:'image',...image,x:pad,y,align});y+=image.height;}
  const contentHeight=Math.max(32,y+pad);
  if(size){
    // The plate is fixed; derive the unit so the measured content fits inside it, then
    // centre the content in the plate so a wide thin strip reads like one.
    const fitted=Math.min(size.width/width,size.height/contentHeight);
    const plateWidth=size.width/fitted,plateHeight=size.height/fitted;
    const dx=(plateWidth-width)/2,dy=(plateHeight-contentHeight)/2;
    for(const item of items){item.x+=dx;item.y+=dy;}
    return {width:plateWidth,height:plateHeight,unit:fitted,physicalWidth:size.width,physicalHeight:size.height,
      outerRadius:radius,cardRadius:radius,controlRadius:radius,variant:'label',
      headingHeight:0,titleLines,textLines,description:[],footerLines:[],columns:1,colWidths:[plateWidth-pad*2],
      pages:[{items,controls:[],bodyHeight:plateHeight,columnHeights:[plateHeight]}]};
  }
  const height=contentHeight;
  return {width,height,unit,physicalWidth:width*unit,physicalHeight:height*unit,
    outerRadius:radius,cardRadius:radius,controlRadius:radius,variant:'label',
    headingHeight:0,titleLines,textLines,description:[],footerLines:[],columns:1,colWidths:[inner],
    pages:[{items,controls:[],bodyHeight:height,columnHeights:[height]}]};
}
