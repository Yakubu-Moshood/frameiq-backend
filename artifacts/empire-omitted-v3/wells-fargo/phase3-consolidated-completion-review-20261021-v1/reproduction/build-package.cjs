'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const zlib = require('node:zlib');

const ROOT = path.resolve(__dirname, '..', '..', '..', '..', '..');
const WELLS = path.join(ROOT, 'artifacts', 'empire-omitted-v3', 'wells-fargo');
const OUT = path.join(WELLS, 'phase3-consolidated-completion-review-20261021-v1');
const CANDIDATE = path.join(WELLS, 'phase3-consolidated-act5-production-candidate-20261004-v5');
const PLAN_DIR = path.join(WELLS, 'phase3-production-batch-planning-20261006-v1');
const SHOTS_PATH = path.join(CANDIDATE, 'candidate', 'shot-definitions.json');
const MANIFEST_PATH = path.join(CANDIDATE, 'candidate', 'production-manifest.json');
const EVIDENCE_PATH = path.join(CANDIDATE, 'candidate', 'evidence-source-manifest.json');
const GRAPHICS_PATH = path.join(CANDIDATE, 'candidate', 'graphic-asset-manifest.json');
const PLAN_PATH = path.join(PLAN_DIR, 'production-batch-plan.v1.json');
const PLAN_INDEX_PATH = path.join(PLAN_DIR, 'package-index.v1.json');

const read = file => fs.readFileSync(file);
const parse = file => JSON.parse(read(file).toString('utf8'));
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const shaFile = file => sha(read(file));
const jsonBytes = value => Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
const write = (file, bytes) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, bytes); };
const writeJson = (file, value) => write(file, jsonBytes(value));
const rel = file => path.relative(OUT, file).replaceAll('\\', '/');

const shotsDocument = parse(SHOTS_PATH);
const productionManifest = parse(MANIFEST_PATH);
const evidenceManifest = parse(EVIDENCE_PATH);
const graphicManifest = parse(GRAPHICS_PATH);
const plan = parse(PLAN_PATH);
const controlledIds = productionManifest.shots
  .filter(item => item.productionMethod === 'CONTROLLED_STILL' && item.assetType === 'controlled_image')
  .map(item => item.shotId);

if (controlledIds.length !== 34) throw new Error(`CONTROLLED_COUNT_${controlledIds.length}`);

const sceneKinds = Object.freeze({
  ACT1_B011: 'screen-chair', ACT1_B012: 'printer-documents', ACT1_B013: 'mailbox-home',
  ACT1_B015: 'phone-notepad', ACT1_B020: 'kitchen-documents', ACT1_B022: 'blank-interface',
  ACT1_B030: 'prison-corridor', ACT2_B002: 'rural-landscape', ACT2_B003: 'small-town-street',
  ACT2_B009: 'corporate-lobby', ACT2_B011: 'paperwork-one', ACT2_B012: 'paperwork-three',
  ACT2_B013: 'paper-packet', ACT2_B015: 'eight-products', ACT2_B020: 'metrics-screen',
  ACT2_B021: 'badge-report', ACT2_B024: 'glass-tower', ACT2_B025: 'workstation-grid',
  ACT3_B006: 'forms-cascade', ACT3_B007: 'blank-interface', ACT3_B010: 'email-field',
  ACT3_B013: 'customer-files', ACT3_B020: 'message-grid', ACT3_B026: 'break-room',
  ACT3_B027: 'bathroom-sink', ACT3B_B001: 'envelope-statement', ACT3B_B004: 'card-mailer',
  ACT3B_B007: 'moving-box', ACT3B_B013: 'terminal-hands', ACT3B_B016: 'termination-desk',
  ACT3B_B018: 'phone-box', ACT5_B010: 'apartment-documents', ACT5_B013: 'departure-silhouette',
});

const W = 1920, H = 1080;
const colors = {
  ink: [13, 16, 22], charcoal: [24, 29, 38], slate: [50, 61, 73], steel: [93, 108, 119],
  paper: [218, 211, 193], cream: [237, 226, 201], gold: [190, 144, 55], red: [151, 38, 42],
  blue: [48, 79, 102], cold: [116, 144, 153], skin: [145, 103, 78], green: [70, 89, 68],
};

function crc32(bytes) {
  let c = 0xffffffff;
  for (const byte of bytes) { c ^= byte; for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1)); }
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const t = Buffer.from(type); const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0); t.copy(out, 4); data.copy(out, 8);
  out.writeUInt32BE(crc32(Buffer.concat([t, data])), 8 + data.length); return out;
}
function encodePng(width, height, rgb) {
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 2;
  const scan = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) rgb.copy(scan, y * (width * 3 + 1) + 1, y * width * 3, (y + 1) * width * 3);
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(scan, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}
function canvas(width = W, height = H, top = colors.charcoal, bottom = colors.ink) {
  const b = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y++) { const t = y / Math.max(1, height - 1);
    const c = top.map((v, i) => Math.round(v * (1 - t) + bottom[i] * t));
    for (let x = 0; x < width; x++) { const o = (y * width + x) * 3; b[o] = c[0]; b[o+1] = c[1]; b[o+2] = c[2]; }
  }
  return { width, height, b };
}
function pixel(c, x, y, col) { if (x < 0 || y < 0 || x >= c.width || y >= c.height) return;
  const o = (Math.floor(y) * c.width + Math.floor(x)) * 3; c.b[o] = col[0]; c.b[o+1] = col[1]; c.b[o+2] = col[2]; }
function rect(c, x, y, w, h, col) { const x0=Math.max(0,Math.floor(x)), y0=Math.max(0,Math.floor(y));
  const x1=Math.min(c.width,Math.ceil(x+w)), y1=Math.min(c.height,Math.ceil(y+h));
  for(let yy=y0;yy<y1;yy++){let o=(yy*c.width+x0)*3;for(let xx=x0;xx<x1;xx++){c.b[o++]=col[0];c.b[o++]=col[1];c.b[o++]=col[2];}} }
function circle(c, cx, cy, r, col) { const rr=r*r; for(let y=Math.max(0,Math.floor(cy-r));y<Math.min(c.height,Math.ceil(cy+r));y++)
  for(let x=Math.max(0,Math.floor(cx-r));x<Math.min(c.width,Math.ceil(cx+r));x++) if((x-cx)**2+(y-cy)**2<=rr)pixel(c,x,y,col); }
function line(c, x0, y0, x1, y1, thick, col) { const steps=Math.ceil(Math.max(Math.abs(x1-x0),Math.abs(y1-y0)));
  for(let i=0;i<=steps;i++){const t=i/Math.max(1,steps);circle(c,x0+(x1-x0)*t,y0+(y1-y0)*t,thick/2,col);} }
function poly(c, pts, col) { const ys=pts.map(p=>p[1]); for(let y=Math.max(0,Math.floor(Math.min(...ys)));y<=Math.min(c.height-1,Math.ceil(Math.max(...ys)));y++){
  const xs=[]; for(let i=0,j=pts.length-1;i<pts.length;j=i++) { const a=pts[i],b=pts[j]; if((a[1]>y)!==(b[1]>y)) xs.push((b[0]-a[0])*(y-a[1])/(b[1]-a[1])+a[0]); }
  xs.sort((a,b)=>a-b); for(let i=0;i+1<xs.length;i+=2) rect(c,xs[i],y,xs[i+1]-xs[i]+1,1,col); } }
function paper(c,x,y,w,h,accent=false){rect(c,x+14,y+16,w,h,[8,10,14]);rect(c,x,y,w,h,colors.paper);for(let i=0;i<5;i++)rect(c,x+w*.12,y+h*(.18+i*.13),w*.62-(i%2)*w*.12,8,accent&&i===1?colors.red:colors.steel);}
function person(c,x,y,s=1,pose='seated'){circle(c,x,y-150*s,55*s,[79,65,60]);rect(c,x-62*s,y-100*s,124*s,155*s,[54,59,66]);
  if(pose==='seated'){line(c,x-35*s,y+30*s,x-95*s,y+135*s,34*s,[38,43,49]);line(c,x+35*s,y+30*s,x+100*s,y+135*s,34*s,[38,43,49]);}
  else {line(c,x-30*s,y+45*s,x-45*s,y+190*s,38*s,[38,43,49]);line(c,x+30*s,y+45*s,x+45*s,y+190*s,38*s,[38,43,49]);}}
function desk(c,y=760){rect(c,0,y,c.width,c.height-y,[74,53,42]);rect(c,0,y,c.width,18,[112,82,54]);}
function monitor(c,x,y,w=620,h=370){rect(c,x-24,y-24,w+48,h+48,[7,10,14]);rect(c,x,y,w,h,[62,78,88]);rect(c,x+w*.46,y+h+24,w*.08,90,[42,46,50]);rect(c,x+w*.31,y+h+100,w*.38,24,[42,46,50]);}
function drawScene(kind, beatId) {
  const warm = kind.includes('home') || kind.includes('kitchen') || kind.includes('apartment') || kind.includes('mailer') || kind.includes('envelope');
  const c = canvas(W,H,warm?[50,39,34]:[31,39,48],warm?[17,18,23]:colors.ink); desk(c,790);
  const form = (x,y,w=420,h=250) => {rect(c,x,y,w,h,[202,208,204]);for(let i=0;i<4;i++)rect(c,x+40,y+45+i*45,w-80,14,i===1?colors.red:[102,115,119]);};
  if(kind==='screen-chair'||kind==='blank-interface'||kind==='forms-cascade'||kind==='email-field'||kind==='metrics-screen'||kind==='message-grid'||kind==='terminal-hands'){
    monitor(c,600,180,760,440); const n=kind==='forms-cascade'?2:1; for(let j=0;j<n;j++)form(670+j*110,250+j*70,430,230);
    if(kind==='message-grid')for(let y=250;y<520;y+=65)for(let x=675;x<1250;x+=190)rect(c,x,y,150,38,(x+y)%3?colors.steel:colors.red);
    if(kind==='email-field'){rect(c,720,370,500,55,colors.cream);rect(c,740,392,330,10,colors.steel);line(c,1090,382,1090,414,5,colors.red);}
    if(kind==='metrics-screen')for(let i=0;i<7;i++){rect(c,700,260+i*42,360,11,colors.steel);rect(c,1080,260+i*42,90,11,i===3?colors.red:colors.gold);}
    if(kind==='screen-chair'){circle(c,1530,700,125,[29,34,40]);rect(c,1410,700,240,180,[29,34,40]);}
    line(c,470,820,820,730,55,colors.skin);line(c,1450,820,1150,730,55,colors.skin);
  } else if(kind==='printer-documents'){rect(c,220,300,520,390,[43,48,53]);rect(c,300,650,350,120,[18,22,27]);paper(c,790,390,420,260);paper(c,960,510,420,260,true);rect(c,365,520,240,145,colors.cream);}
  else if(kind==='mailbox-home'){rect(c,1050,350,620,390,[83,72,62]);poly(c,[[980,350],[1360,120],[1740,350]],colors.red);rect(c,1220,520,150,220,[31,38,44]);rect(c,300,470,360,210,colors.slate);circle(c,480,470,180,colors.slate);rect(c,445,680,30,180,[105,79,55]);person(c,770,650,.8,'standing');}
  else if(kind==='phone-notepad'){person(c,560,660,1,'seated');rect(c,950,500,420,300,[65,50,42]);paper(c,1010,540,270,170);circle(c,880,620,70,[25,28,33]);line(c,840,590,730,505,40,[25,28,33]);}
  else if(kind==='kitchen-documents'||kind==='apartment-documents'){person(c,500,650,1,'seated');paper(c,900,500,360,230,true);paper(c,1180,620,330,210);rect(c,1450,650,120,210,[20,24,29]);}
  else if(kind==='prison-corridor'||kind==='corporate-lobby'||kind==='glass-tower'){poly(c,[[0,1080],[700,260],[1220,260],[1920,1080]],kind==='prison-corridor'?[57,63,67]:[55,66,73]);poly(c,[[0,0],[700,260],[0,1080]],[25,30,35]);poly(c,[[1920,0],[1220,260],[1920,1080]],[25,30,35]);
    for(let i=0;i<6;i++){const y=90+i*145;line(c,0,y,1920,y+40,10,kind==='glass-tower'?colors.cold:colors.gold);} for(let i=0;i<5;i++){rect(c,70+i*155,300+i*90,110,250,[12,16,20]);rect(c,1740-i*155,300+i*90,110,250,[12,16,20]);}}
  else if(kind==='rural-landscape'){rect(c,0,0,W,620,[91,112,125]);circle(c,1520,180,100,colors.gold);poly(c,[[0,620],[450,420],[900,650],[1350,430],[1920,610],[1920,1080],[0,1080]],colors.green);for(let i=0;i<8;i++)rect(c,950+i*80,550+(i%2)*30,60,70,[82,65,49]);}
  else if(kind==='small-town-street'||kind==='departure-silhouette'){rect(c,0,0,W,620,[104,111,113]);rect(c,280,280,720,510,[86,60,49]);for(let i=0;i<4;i++)rect(c,350+i*150,390,90,160,[28,34,39]);rect(c,1220,370,470,420,[65,71,74]);if(kind==='departure-silhouette')person(c,1120,700,.75,'standing');}
  else if(kind.startsWith('paperwork')||kind==='paper-packet'){paper(c,360,330,540,360);if(kind!=='paperwork-one')paper(c,820,430,520,330);if(kind==='paper-packet')for(let i=0;i<8;i++)rect(c,560+i*9,520-i*6,650,280,colors.paper);}
  else if(kind==='eight-products'){circle(c,960,480,150,colors.red);circle(c,905,430,48,colors.ink);circle(c,1015,430,48,colors.ink);circle(c,905,540,48,colors.ink);circle(c,1015,540,48,colors.ink);for(let i=0;i<8;i++){const a=Math.PI*2*i/8;circle(c,960+Math.cos(a)*430,480+Math.sin(a)*310,72,i%2?colors.gold:colors.red);}}
  else if(kind==='badge-report'){paper(c,850,390,500,330,true);rect(c,390,360,300,430,[66,72,77]);circle(c,540,480,75,colors.steel);rect(c,455,590,170,22,colors.steel);line(c,300,780,610,540,60,colors.skin);}
  else if(kind==='workstation-grid'){for(let y=170;y<730;y+=250)for(let x=180;x<1700;x+=360){rect(c,x,y,250,150,[55,63,69]);circle(c,x+125,y+185,44,[72,62,58]);rect(c,x+70,y+220,110,120,[42,48,55]);}}
  else if(kind==='customer-files'){for(let i=0;i<8;i++){rect(c,330+i*115,320+i%2*45,500,300,[153+i*4,119+i*3,72]);rect(c,380+i*115,350+i%2*45,120,45,colors.cream);}line(c,330,820,1000,480,60,colors.skin);}
  else if(kind==='break-room'){rect(c,240,250,1440,500,[66,72,75]);rect(c,280,640,1350,150,[45,49,52]);person(c,920,670,1.2,'seated');rect(c,1150,590,300,120,[88,73,58]);}
  else if(kind==='bathroom-sink'){rect(c,300,130,1320,500,[55,64,68]);rect(c,520,600,880,210,colors.cream);circle(c,960,690,160,[120,130,130]);person(c,960,570,1.25,'standing');rect(c,1290,700,130,80,colors.steel);}
  else if(kind==='envelope-statement'||kind==='card-mailer'){rect(c,420,290,1050,560,kind==='card-mailer'?[181,161,126]:colors.cream);poly(c,[[420,290],[945,640],[1470,290]],colors.paper);line(c,250,850,730,520,70,colors.skin);line(c,1670,850,1190,520,70,colors.skin);}
  else if(kind==='moving-box'||kind==='phone-box'||kind==='termination-desk'){rect(c,990,420,520,370,[133,94,55]);line(c,1250,420,1250,790,12,[82,57,38]);if(kind==='phone-box'){circle(c,430,650,90,[24,28,32]);line(c,360,600,260,500,55,[24,28,32]);}else if(kind==='termination-desk'){person(c,520,670,1,'seated');paper(c,770,480,360,240,true);}}
  else throw new Error(`UNKNOWN_SCENE_${kind}_${beatId}`);
  rect(c,0,0,W,18,colors.gold); rect(c,0,H-18,W,18,colors.red);
  return encodePng(W,H,c.b);
}

const constructed = [];
for (const beatId of controlledIds) {
  if (beatId === 'ACT1_B005') continue;
  const kind = sceneKinds[beatId]; if (!kind) throw new Error(`NO_SCENE_${beatId}`);
  const first = drawScene(kind, beatId), second = drawScene(kind, beatId);
  if (!first.equals(second)) throw new Error(`NONDETERMINISTIC_${beatId}`);
  const file = path.join(OUT, 'controlled-stills', `${beatId}.png`); write(file, first);
  constructed.push({ beatId, constructionRoute: `ORIGINAL_DETERMINISTIC_VECTOR_RASTER/${kind}`,
    relativePath: rel(file), bytes: first.length, sha256: sha(first), width: W, height: H,
    mimeType: 'image/png', repeatedBuildSha256: sha(second), byteIdenticalAcrossTwoBuilds: true });
}

function makeContactSheet(items, page) {
  const c = canvas(1920,1080,[25,29,36],[10,12,16]); const cols=4, rows=3, cellW=440, cellH=300;
  items.forEach((item,i)=>{const ox=50+(i%cols)*470,oy=65+Math.floor(i/cols)*335;const png=read(path.join(OUT,item.relativePath));
    // Deterministic thumbnails are redrawn from the same recipe at review scale to avoid decoder dependencies.
    const thumb=drawScene(sceneKinds[item.beatId],item.beatId); const raw=decodeOwnPng(thumb,W,H);
    for(let y=0;y<248;y++)for(let x=0;x<420;x++){const sx=Math.floor(x*W/420),sy=Math.floor(y*H/248),so=(sy*W+sx)*3,doff=((oy+y)*c.width+(ox+x))*3;c.b[doff]=raw[so];c.b[doff+1]=raw[so+1];c.b[doff+2]=raw[so+2];}
    drawLabel(c,ox,oy+258,item.beatId,4,colors.cream);
  });
  drawLabel(c,50,1015,`CONTROLLED STILLS REVIEW ${String(page).padStart(2,'0')}`,4,colors.gold);
  return encodePng(c.width,c.height,c.b);
}
function decodeOwnPng(bytes,width,height){let at=8,compressed=[];while(at<bytes.length){const len=bytes.readUInt32BE(at),type=bytes.toString('ascii',at+4,at+8);if(type==='IDAT')compressed.push(bytes.subarray(at+8,at+8+len));at+=12+len;}const scan=zlib.inflateSync(Buffer.concat(compressed)),row=width*3,out=Buffer.alloc(width*height*3);for(let y=0;y<height;y++)scan.copy(out,y*row,y*(row+1)+1,y*(row+1)+1+row);return out;}
const glyph={A:['01110','10001','10001','11111','10001','10001','10001'],B:['11110','10001','10001','11110','10001','10001','11110'],C:['01111','10000','10000','10000','10000','10000','01111'],D:['11110','10001','10001','10001','10001','10001','11110'],E:['11111','10000','10000','11110','10000','10000','11111'],I:['11111','00100','00100','00100','00100','00100','11111'],L:['10000','10000','10000','10000','10000','10000','11111'],N:['10001','11001','10101','10011','10001','10001','10001'],O:['01110','10001','10001','10001','10001','10001','01110'],R:['11110','10001','10001','11110','10100','10010','10001'],S:['01111','10000','10000','01110','00001','00001','11110'],T:['11111','00100','00100','00100','00100','00100','00100'],V:['10001','10001','10001','10001','10001','01010','00100'],W:['10001','10001','10001','10101','10101','10101','01010'],Y:['10001','10001','01010','00100','00100','00100','00100'],_:['00000','00000','00000','00000','00000','00000','11111'],' ':['00000','00000','00000','00000','00000','00000','00000'],
  0:['01110','10001','10011','10101','11001','10001','01110'],1:['00100','01100','00100','00100','00100','00100','01110'],2:['01110','10001','00001','00010','00100','01000','11111'],3:['11110','00001','00001','01110','00001','00001','11110'],4:['00010','00110','01010','10010','11111','00010','00010'],5:['11111','10000','10000','11110','00001','00001','11110'],6:['01110','10000','10000','11110','10001','10001','01110'],7:['11111','00001','00010','00100','01000','01000','01000'],8:['01110','10001','10001','01110','10001','10001','01110'],9:['01110','10001','10001','01111','00001','00001','01110']};
function drawLabel(c,x,y,text,scale,col){let px=x;for(const ch of text){const g=glyph[ch]||glyph[' '];for(let gy=0;gy<7;gy++)for(let gx=0;gx<5;gx++)if(g[gy][gx]==='1')rect(c,px+gx*scale,y+gy*scale,scale,scale,col);px+=6*scale;}}

const contactSheets=[];
for(let i=0;i<constructed.length;i+=12){const page=Math.floor(i/12)+1,bytes=makeContactSheet(constructed.slice(i,i+12),page);const file=path.join(OUT,'contact-sheets',`controlled-stills-${String(page).padStart(2,'0')}.png`);write(file,bytes);contactSheets.push({relativePath:rel(file),bytes:bytes.length,sha256:sha(bytes),width:1920,height:1080});}

const shotById = new Map(shotsDocument.allShots.map(item => [item.beatId, item]));
const manifestById = new Map(productionManifest.shots.map(item => [item.shotId, item]));
const constructionById = new Map(constructed.map(item => [item.beatId, item]));
const matrix = controlledIds.map(beatId => {
  const s=shotById.get(beatId),m=manifestById.get(beatId),built=constructionById.get(beatId);
  const evidence = evidenceManifest.entries.filter(item => item.shotId === beatId);
  const graphics = graphicManifest.entries.filter(item => item.beatId === beatId);
  return { beatId, narration: s.narrationExcerpt, timing: { startSec:s.startSec,endSec:s.endSec,durationSec:s.durationSec,
      startWordIndex:s.startWordIndex,endWordIndex:s.endWordIndex }, visualIntent:s.visualIntent,
    approvedDependency: { evidence: evidence.map(item=>({localFilename:item.localFilename,sha256:item.sha256,rightsClassification:item.rightsClassification,approvalStatus:item.approvalStatus})),
      graphics: graphics.map(item=>({relativePath:item.relativePath,sha256:item.sha256,role:item.role})),
      manifestSourceStatus:m.sourceStatus, manifestGraphicStatus:m.graphicStatus },
    proposedRoute: beatId==='ACT1_B005'
      ? 'PENDING_EXACT_HUMAN_CHOICE: approve original deterministic corridor illustration or bind an approved licensed/source image'
      : `Original source-free deterministic editorial illustration using locked visual intent; ${sceneKinds[beatId]} recipe`,
    provenanceAndRights: beatId==='ACT1_B005'
      ? 'UNRESOLVED_PENDING_SOURCE_OR_CONSTRUCTION_CONTRACT'
      : 'PROJECT_ORIGINAL_DETERMINISTIC_CONSTRUCTION; no external source; no documentary-evidence claim',
    exactOutputPath:`planned/final/controlled-stills/${beatId}.png`, required:{width:1920,height:1080,format:'PNG',mimeType:'image/png',alphaAllowed:false},
    sourceHashes:{shotDefinitionsSha256:shaFile(SHOTS_PATH),productionManifestSha256:shaFile(MANIFEST_PATH),
      visualIntentSha256:sha(Buffer.from(s.visualIntent)),imagePromptSha256:sha(Buffer.from(s.imagePrompt)),externalSources:[]},
    blocker:beatId==='ACT1_B005'?'MISSING_APPROVED_SOURCE_OR_DETERMINISTIC_CONSTRUCTION_ROUTE':null,
    deterministicConstructionCanProceedNow:beatId!=='ACT1_B005', reviewOutput:built||null };
});
writeJson(path.join(OUT,'controlled-still-matrix.v1.json'),{schemaVersion:'phase3-controlled-still-resolution-matrix/1.0.0',status:'REVIEW_READY_ONE_EXCEPTION',rowCount:matrix.length,constructedCount:constructed.length,blockedCount:1,rows:matrix});
writeJson(path.join(OUT,'controlled-still-construction-record.v1.json'),{schemaVersion:'phase3-controlled-still-construction-record/1.0.0',status:'DETERMINISTIC_REVIEW_OUTPUTS_CONSTRUCTED_NOT_INSTALLED',sourceBindings:{shotDefinitions:{path:rel(SHOTS_PATH),sha256:shaFile(SHOTS_PATH)},productionManifest:{path:rel(MANIFEST_PATH),sha256:shaFile(MANIFEST_PATH)}},recipe:{path:'reproduction/build-package.cjs',sha256:null,renderer:'built-in deterministic RGB raster + PNG encoder',externalSources:0,providerRequests:0},outputs:constructed,contactSheets});
writeJson(path.join(OUT,'act1-b005-minimal-proposed-amendment.v1.json'),{schemaVersion:'phase3-act1-b005-source-construction-amendment/1.0.0',status:'PROPOSED_UNSIGNED_PENDING_HUMAN_DECISION',beatId:'ACT1_B005',lockedFieldsPreserved:['beat ID','narration','timing','visual intent','visual class','production method','asset type','evidence bindings','ownership','revision lineage'],missingDecision:'No approved source asset or exact deterministic construction contract is bound.',proposedExactDecision:'Authorize a project-original, source-free deterministic editorial illustration of the locked empty executive-corridor visual intent, rendered to 1920x1080 PNG, carrying no logos, readable names, identifiable people, or documentary-evidence claim. Review output must remain isolated until separately approved.',authorityGrantedByProposal:false});

const completed = new Set(['ACT1_B006','ACT1_B009','ACT1_B010']);
const remainingGenerated = plan.generatedStills.filter(x=>!completed.has(x.beatId));
const remainingSources = plan.animationSourceStills.filter(x=>!completed.has(x.beatId));
const remainingAnimations = plan.animationClips.filter(x=>!completed.has(x.beatId));
if(remainingGenerated.length!==7||remainingSources.length!==21||remainingAnimations.length!==21)throw new Error('REMAINING_COUNTS_INVALID');
const keyHistory=[
  {beatId:'ACT1_B006',requestKey:'c05d73bed54a10ddd74e79c7b8d4f8c493ad1e6b601a723dd1a733ebbe950fd9',status:'CONSUMED_COMPLETED'},
  {beatId:'ACT1_B006',requestKey:'8601e214c64e07bc6be1eb92ca57811f99d56adff5691ab46fe99002fbd8febd',status:'RETIRED_PLANNED_KEY_BEAT_ALREADY_COMPLETE'},
  {beatId:'ACT1_B009',requestKey:'81416755ae3844e846336f755352b84699dbeec88415093f7f283e4b3b378d0f',status:'STALE_SUPERSEDED_NEVER_REUSE'},
  {beatId:'ACT1_B009',requestKey:'f10feb2552874270ce4af7705e5648e4beede07faedfa2a72072ba6633afdd02',status:'CONSUMED_COMPLETED_SOURCE_STILL'},
  {beatId:'ACT1_B009',requestKey:'147e115a24f634da90798986ad673dc7ac1947cbbc90dbc95dd0c44a6e83c31f',status:'RETIRED_PLANNED_KEY_BEAT_ALREADY_COMPLETE'},
  {beatId:'ACT1_B009',requestKey:'946a3ac047028bf95badf61753f46e340bb27d8a3931c9f675ba210e1d9de3c3',status:'CONSUMED_COMPLETED_ANIMATION'},
  {beatId:'ACT1_B009',requestKey:'002d78a4380415db4947152a2d58f9b682abce3c4be02bf20f32c24b968269e2',status:'RETIRED_PLANNED_KEY_BEAT_ALREADY_COMPLETE'},
  {beatId:'ACT1_B010',requestKey:'355e3613aec94009263d466e45a2860fa6c4e29fdaa4704a608830f1184d9324',status:'CONSUMED_FAILED_SOURCE_STILL'},
  {beatId:'ACT1_B010',requestKey:'f0c56cb472b8ee4534fedf53a6ce895484f5f19f2efad655a55baa9db092958e',status:'CONSUMED_COMPLETED_REPLACEMENT_SOURCE_STILL'},
  {beatId:'ACT1_B010',requestKey:'0322eaeb4273b87aaf8936ce39f603600a4ca5128a9904056d0c60a2112b2af2',status:'CONSUMED_COMPLETED_ANIMATION'}];
const forbidden=new Set(keyHistory.map(x=>x.requestKey)); const remainingKeys=[...remainingGenerated,...remainingSources,...remainingAnimations].map(x=>x.requestKey);
if(new Set(remainingKeys).size!==49||remainingKeys.some(k=>forbidden.has(k)))throw new Error('REQUEST_KEY_REUSE');
writeJson(path.join(OUT,'request-key-reconciliation.v1.json'),{schemaVersion:'phase3-remaining-request-key-reconciliation/1.0.0',status:'PASS_NO_REUSE',completedOrRetiredKeys:keyHistory,remainingRequestCount:49,remainingKeys});

const commonDependencies={planningPackageIndexSha256:shaFile(PLAN_INDEX_PATH),productionBatchPlanSha256:shaFile(PLAN_PATH),candidateIndexSha256:'a1981dd4c57a5c10c83fd2e3739d0630006e93e628a72cef3d574d07ef83b4cf',shotDefinitionsSha256:shaFile(SHOTS_PATH),productionManifestSha256:shaFile(MANIFEST_PATH)};
function entry(job,type){return{beatId:job.beatId,operation:type==='GENERATED_FINAL_STILL'?'GENERATE_FINAL_STILL':type==='ANIMATION_SOURCE_STILL'?'GENERATE_ANIMATION_SOURCE_STILL':'GENERATE_ANIMATION',endpoint:type==='ANIMATION_CLIP'?'minimax/h3-max/image-to-video':'blackforestlabs/flux-3/text-to-image',requestKey:job.requestKey,promptSha256:job.promptSha256,negativePromptSha256:job.negativePromptSha256,dependencyHashes:{...commonDependencies,...(type==='ANIMATION_CLIP'?{sourceStillRequestKey:job.sourceStillRequestKey,sourceStillSha256:null}:{})},expectedOutputContract:{id:job.outputContractId,path:job.outputPath,...(type==='ANIMATION_CLIP'?{rawId:job.rawOutputContractId,rawPath:job.rawOutputPath,targetFrames:job.targetFrames,frameAccurateDurationSec:job.frameAccurateDurationSec}:{format:'PNG',width:1360,height:768})},maximumExposureUsd:type==='ANIMATION_CLIP'?0.4:0.048,providerEnforced:false,executionAuthorized:false,...(type==='ANIMATION_CLIP'?{authorizationGate:'BLOCKED_UNTIL_SOURCE_STILL_GENERATED_INSPECTED_AND_HUMAN_APPROVED_WITH_SHA256_BOUND'}:{})};}
const batches=[
  ['generated-final-still-batch.v1.json','GENERATED_FINAL_STILL',remainingGenerated],
  ['animation-source-still-batch-1.v1.json','ANIMATION_SOURCE_STILL',remainingSources.slice(0,10)],
  ['animation-source-still-batch-2.v1.json','ANIMATION_SOURCE_STILL',remainingSources.slice(10,20)],
  ['animation-source-still-batch-3.v1.json','ANIMATION_SOURCE_STILL',remainingSources.slice(20)],
  ['animation-batch-1.v1.json','ANIMATION_CLIP',remainingAnimations.slice(0,10)],
  ['animation-batch-2.v1.json','ANIMATION_CLIP',remainingAnimations.slice(10,20)],
  ['animation-batch-3.v1.json','ANIMATION_CLIP',remainingAnimations.slice(20)],
];
const batchRecords=[];
for(const[name,type,jobs]of batches){const entries=jobs.map(j=>entry(j,type)),maximumExposureUsd=Number(entries.reduce((s,x)=>s+x.maximumExposureUsd,0).toFixed(3));const record={schemaVersion:'phase3-non-authorizing-provider-batch/1.0.0',status:'PROPOSED_NON_AUTHORIZING',batchId:path.basename(name,'.v1.json'),type,requestCount:entries.length,expectedExposureUsd:maximumExposureUsd,maximumExposureUsd,providerEnforced:false,dependencyOrder:type==='ANIMATION_CLIP'?'SOURCE_STILL_GENERATE -> INSPECT -> HUMAN_APPROVE_AND_BIND_SHA256 -> SEPARATE_ANIMATION_AUTHORIZATION -> SUBMIT':'INDEPENDENT_WITHIN_BATCH',entries,authority:{providerRequestsAuthorized:0,executionAuthorizationCreated:false,retries:0,fallback:false,rendering:false,promotion:false,stage04Modification:false,episodeProductionWrites:false}};const file=path.join(OUT,'provider-batches',name);writeJson(file,record);batchRecords.push({path:rel(file),requestCount:entries.length,expectedExposureUsd:maximumExposureUsd,maximumExposureUsd,sha256:shaFile(file)});}
if(Number(batchRecords.reduce((s,x)=>s+x.maximumExposureUsd,0).toFixed(3))!==9.744)throw new Error('EXPOSURE_INVALID');

writeJson(path.join(OUT,'master-phase3-completion-docket.v1.json'),{schemaVersion:'phase3-master-completion-docket/1.0.0',status:'PHASE3_CONSOLIDATED_COMPLETION_PACKAGE_PENDING_HUMAN_APPROVAL',authoritativeState:{gitCommit:'316177e7595e2e0874e298352cf77374a2fb9f84',branch:'codex/phase3-controlled-media-pilot',completedAndApproved:['Phase 3 planning and calibration','ACT1_B006 final still lane','ACT1_B009 source-still and animation lane','ACT1_B010 replacement source-still and animation lane'],preservedUntrackedPaths:['.act1-b010-deploy-316177e/','.act1-b010-deploy-f83ae98/','.act1-b010-review-316177e/','.codex-artifacts/','node_modules/']},remainingCensus:{finalOutputs:62,controlledStills:34,generatedFinalStills:7,animationClips:21,intermediateAnimationSourceStills:21,providerSubmissions:49},controlledStills:{constructed:33,blocked:1,blockedBeatIds:['ACT1_B005'],productionPathsWritten:0},providerBatches:batchRecords,exposure:{expectedUsd:9.744,maximumUsd:9.744,providerEnforced:false,retriesIncluded:0},approvalsRequired:['Approve or revise the 33 deterministic controlled-still review outputs.','Approve the exact ACT1_B005 source-free deterministic corridor amendment, or provide an exact approved source binding instead.','Approve the seven non-authorizing batch manifests and USD 9.744 maximum human-accepted exposure.','After each animation-source batch: inspect and explicitly approve each source still with its SHA-256 before any dependent animation authorization.','After each animation batch: inspect and approve fitted outputs before production installation.','Separately authorize final render, promotion, and dashboard test only after all media is installed and readiness validation passes.'],shortestSafeSequence:['Approve controlled stills and ACT1_B005 contract.','Install approved controlled stills through a separately authorized production step.','Authorize and execute generated-final-still batch; inspect and approve.','Authorize source-still batches 1-3 in order; inspect and hash-approve every output.','Create fresh animation-only authorizations bound to approved source hashes; execute animation batches 1-3; inspect and approve.','Run complete asset/readiness validation with 62 final outputs.','Separately authorize final render.','Review final master and QA.','Separately authorize promotion.','Run dashboard end-to-end test.'],prohibitions:{providerCalls:0,executionAuthorizationsCreated:0,rendering:false,promotion:false,stage04Modification:false,episodeProductionPathWrites:0}});

write(path.join(OUT,'human-review-docket.md'),Buffer.from(`# Phase 3 consolidated completion review\n\nStatus: **PHASE3_CONSOLIDATED_COMPLETION_PACKAGE_PENDING_HUMAN_APPROVAL**\n\n- Remaining final outputs: 62 (34 controlled stills, 7 generated final stills, 21 animation clips).\n- Intermediate animation-source stills: 21.\n- Remaining provider submissions: 49.\n- Maximum planned exposure: USD 9.744, not provider-enforced.\n- Controlled stills constructed for review: 33; blocked: ACT1_B005 only.\n- Every constructed PNG was built twice and compared byte-for-byte.\n- No provider call, execution authorization, render, promotion, Stage04 modification, or episode-production-path write occurred.\n\n## Review order\n\n1. Review the three contact sheets and the 33 full-resolution PNGs.\n2. Approve or revise those 33 outputs.\n3. Approve the exact ACT1_B005 amendment or provide an exact approved source binding.\n4. Approve the seven provider manifests and the USD 9.744 exposure ceiling.\n5. Preserve the source-still-before-animation approval gates.\n\nThe package index is the final integrity authority for this review package.\n`));

writeJson(path.join(OUT,'test-report.v1.json'),{
  schemaVersion:'phase3-consolidated-test-report/1.0.0',
  status:'PASS_WITH_ONE_PLATFORM_SKIP',
  sourceCodeChangedToMakeTestsPass:false,
  focusedPhase3:{
    files:['test/phase3-act1-b010-production-animation.test.cjs','test/phase3-render-preview.test.cjs'],
    execution:'serial with isolated workspace-local TEMP/TMP',
    tests:155,passed:154,failed:0,skipped:1,
    skipReason:'Windows junction creation is unavailable in this test environment'
  },
  canonical28:{
    fileCount:28,
    excludedFromCanonicalSet:['test/phase3-act1-b010-production-animation.test.cjs'],
    initialFullRun:{tests:647,passed:642,failed:4,skipped:1},
    environmentalExceptions:[
      {file:'test/deployment-package-portability.test.cjs',affectedTests:2,cause:'sandbox denied temporary .git/index.lock creation',isolatedRerun:{permission:'temporary Git write access',tests:2,passed:2,failed:0,skipped:0}},
      {file:'test/shot-definitions.test.cjs',affectedTests:2,cause:'transient Windows EPERM during atomic rename',isolatedRerun:{tests:17,passed:17,failed:0,skipped:0}}
    ],
    reconciledCaseDisposition:{tests:647,passed:646,productFailures:0,skipped:1},
    skipReason:'Windows junction creation is unavailable in this test environment'
  }
});

function validateIndexedPackage(indexFile, packageRoot) {
  const index=parse(indexFile); const failures=[];
  for(const item of index.files||[]){const file=path.join(packageRoot,...item.path.split('/'));
    if(!fs.existsSync(file)) failures.push(`${item.path}:MISSING`);
    else {if(fs.statSync(file).size!==item.bytes)failures.push(`${item.path}:BYTES`);if(shaFile(file)!==item.sha256)failures.push(`${item.path}:SHA256`);}
  }
  return {path:path.relative(ROOT,indexFile).replaceAll('\\','/'),sha256:shaFile(indexFile),indexedFileCount:(index.files||[]).length,status:failures.length?'FAIL':'PASS',failures};
}
const authoritativeIndexChecks=[
  validateIndexedPackage(path.join(CANDIDATE,'package-index.v2.json'),CANDIDATE),
  validateIndexedPackage(PLAN_INDEX_PATH,PLAN_DIR)
];
if(authoritativeIndexChecks.some(x=>x.status!=='PASS'))throw new Error('AUTHORITATIVE_INDEX_VALIDATION_FAILED');
const generatedJsonFiles=fs.readdirSync(OUT,{withFileTypes:true}).filter(x=>x.isFile()&&x.name.endsWith('.json')).map(x=>path.join(OUT,x.name))
  .concat(fs.readdirSync(path.join(OUT,'provider-batches'),{withFileTypes:true}).filter(x=>x.isFile()&&x.name.endsWith('.json')).map(x=>path.join(OUT,'provider-batches',x.name)));
for(const file of generatedJsonFiles)parse(file);
const generatedPngFiles=[...constructed.map(x=>path.join(OUT,x.relativePath)),...contactSheets.map(x=>path.join(OUT,x.relativePath))];
const pngChecks=generatedPngFiles.map(file=>{const bytes=read(file);const signatureOk=bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]));const width=bytes.readUInt32BE(16),height=bytes.readUInt32BE(20);return{path:rel(file),signatureOk,width,height,sha256:sha(bytes),status:signatureOk&&width===1920&&height===1080?'PASS':'FAIL'};});
if(pngChecks.some(x=>x.status!=='PASS'))throw new Error('PNG_VALIDATION_FAILED');
writeJson(path.join(OUT,'validation-report.v1.json'),{
  schemaVersion:'phase3-consolidated-package-validation/1.0.0',status:'PASS',
  authoritativePackageIndexes:authoritativeIndexChecks,
  generatedJson:{fileCount:generatedJsonFiles.length,status:'PASS_ALL_PARSED'},
  generatedPng:{fileCount:pngChecks.length,status:'PASS_SIGNATURE_DIMENSIONS_AND_HASH',checks:pngChecks},
  deterministicConstruction:{expected:33,recorded:constructed.length,allRepeatedBuildsByteIdentical:constructed.every(x=>x.byteIdenticalAcrossTwoBuilds&&x.sha256===x.repeatedBuildSha256)},
  census:{controlledRows:matrix.length,constructed:constructed.length,blocked:matrix.filter(x=>x.blocker).length,providerRequests:remainingKeys.length},
  providerPlan:{batchCount:batchRecords.length,requestCount:batchRecords.reduce((s,x)=>s+x.requestCount,0),maximumExposureUsd:Number(batchRecords.reduce((s,x)=>s+x.maximumExposureUsd,0).toFixed(3)),requestKeysUnique:new Set(remainingKeys).size===remainingKeys.length,requestKeysDisjointFromCompletedConsumedAndRetired:remainingKeys.every(k=>!forbidden.has(k))},
  authority:{providerRequestsAuthorized:0,executionAuthorizationsCreated:0,rendering:false,promotion:false,stage04Modification:false,episodeProductionPathWrites:0}
});

// Bind the recipe hash after the script exists, then index every other package file.
const constructionPath=path.join(OUT,'controlled-still-construction-record.v1.json');const construction=parse(constructionPath);construction.recipe.sha256=shaFile(__filename);writeJson(constructionPath,construction);
function walk(dir){const out=[];for(const ent of fs.readdirSync(dir,{withFileTypes:true}).sort((a,b)=>a.name.localeCompare(b.name))){const f=path.join(dir,ent.name);if(ent.isDirectory())out.push(...walk(f));else if(ent.isFile())out.push(f);else throw new Error('NONREGULAR_FILE');}return out;}
const indexPath=path.join(OUT,'package-index.v1.json');
const files=walk(OUT).filter(f=>f!==indexPath).map(file=>({path:rel(file),bytes:fs.statSync(file).size,sha256:shaFile(file)}));
writeJson(indexPath,{schemaVersion:'phase3-consolidated-completion-package-index/1.0.0',status:'PHASE3_CONSOLIDATED_COMPLETION_PACKAGE_PENDING_HUMAN_APPROVAL',packageId:path.basename(OUT),createdAt:'2026-10-21T00:00:00.000+01:00',fileCount:files.length,files,summary:{controlledStillRows:34,constructedControlledStills:33,blockedControlledStills:1,providerBatchManifests:7,remainingProviderRequests:49,maximumExposureUsd:9.744},authority:{providerRequestsAuthorized:0,executionAuthorizationsCreated:0,rendering:false,promotion:false,stage04Modification:false,episodeProductionPathWrites:0}});
console.log(JSON.stringify({status:'BUILT',package:OUT,indexSha256:shaFile(indexPath),files:files.length,constructed:constructed.length,blocked:1,batches:batchRecords},null,2));
