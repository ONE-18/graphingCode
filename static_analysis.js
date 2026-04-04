// ─── Constants ────────────────────────────────────────────────────────────────
const FILE_COLORS = ['#7c6aff','#3ecfb0','#ff7b5a','#f0c040','#e073ff','#4dc8ff','#7fff6a','#ff6abf'];
const NODE_H     = 28;
const CHAR_W     = 7.0;   // approx px per char at 11px monospace
const PAD_X      = 16;
const NODE_MIN_W = 60;
const CLUSTER_PAD = 24;   // padding around nodes inside a cluster box

// ─── State ────────────────────────────────────────────────────────────────────
const S = {
  files: {},
  zoom: null, svgSel: null, gSel: null,
  sim: null,
  nodes: [], edges: [], clusters: {}, recursiveCalls: [],
  nodeSelMap: {},   // id -> d3 selection of <g>
  clusterSelMap: {}, // filename -> {rect, label}
  linkSelArr: [],   // array of {sel, source, target}
};

// ─── Python parser ───────────────────────────────────────────────────────────
function parsePythonFile(code, filename) {
  const lines = code.split('\n');
  const functions = [];
  const scopeStack = [], indentStack = [-1];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim() || line.trim().startsWith('#')) continue;
    const indent = line.match(/^(\s*)/)[1].length;
    while (indentStack.length > 1 && indent <= indentStack[indentStack.length - 1]) {
      indentStack.pop(); scopeStack.pop();
    }
    const cm = line.match(/^\s*class\s+(\w+)[\s:(]/);
    if (cm) { scopeStack.push({type:'class',name:cm[1]}); indentStack.push(indent); continue; }
    const fm = line.match(/^\s*(?:async\s+)?def\s+(\w+)\s*\(/);
    if (fm) {
      const fn = fm[1];
      const cls = [...scopeStack].reverse().find(s => s.type==='class');
      const qual = cls ? `${cls.name}.${fn}` : fn;
      functions.push({ id:`${filename}::${qual}`, name:qual, shortName:fn, file:filename, line:i+1, isMethod:!!cls, className:cls?.name??null, defIndent:indent, recursive:false });
      scopeStack.push({type:'func',name:qual}); indentStack.push(indent);
    }
  }

  const byQual={}, byShort={};
  functions.forEach(f => { byQual[f.name]=f; if(!byShort[f.shortName]) byShort[f.shortName]=f; });

  const sorted = [...functions].sort((a,b)=>a.line-b.line);
  function ownerAt(li,ind) {
    let best=null;
    for (const f of sorted) {
      if (f.line-1>li) break;
      if (f.defIndent<ind && (!best||f.defIndent>best.defIndent||f.line>best.line)) best=f;
    }
    return best;
  }

  const SKIP = new Set(['if','for','while','with','return','yield','raise','assert','print','len',
    'range','str','int','float','list','dict','set','tuple','bool','type','isinstance','issubclass',
    'hasattr','getattr','setattr','super','property','staticmethod','classmethod','enumerate','zip',
    'map','filter','sorted','reversed','any','all','min','max','sum','abs','round','open','input',
    'format','repr','id','hash','dir','vars','iter','next','append','extend','insert','remove','pop',
    'update','get','keys','values','items','split','join','strip','replace','find','index','upper',
    'lower','startswith','endswith','Exception','ValueError','TypeError','KeyError','IndexError',
    'AttributeError','RuntimeError','StopIteration','NotImplementedError','object','exec','eval']);

  // Collect raw call occurrences (targetName) and defer resolution across files
  const calls=[]; const seen=new Set();
  for (let i=0;i<lines.length;i++) {
    const raw=lines[i].replace(/#.*$/,'');
    const indent=raw.match(/^(\s*)/)[1].length;
    if (!raw.trim()) continue;
    const owner=ownerAt(i,indent);
    if (!owner) continue;
    const re=/\b([\w]+(?:\.[\w]+)*)\s*\(/g; let m;
    while ((m=re.exec(raw))!==null) {
      const rawName=m[1];
      const parts=rawName.split('.');
      const name=parts[parts.length-1];
      if (SKIP.has(name)||/^[A-Z]/.test(name)) continue;
      const k=`${owner.id}→${rawName}`;
      if (!seen.has(k)) {
        seen.add(k);
        calls.push({ source: owner.id, targetName: rawName, line: i+1 });
      }
    }
  }
  return {filename,functions,calls};
}

// Resolve raw call targets (from parsePythonFile) into concrete function ids
function resolveCalls(allFiles) {
  const funcById = {};
  const funcByQual = {};
  const funcByShort = {};
  // Collect functions across all files
  Object.values(allFiles).forEach(({functions})=>{
    functions.forEach(f=>{
      funcById[f.id]=f;
      funcByQual[f.name]=f;
      (funcByShort[f.shortName]||(funcByShort[f.shortName]=[])).push(f);
    });
  });

  const resolved = [];
  Object.values(allFiles).forEach(({calls})=>{
    calls.forEach(c=>{
      const owner = funcById[c.source];
      if (!owner) return;
      const parts = c.targetName.split('.');
      const short = parts[parts.length-1];
      let tgt = null;
      if ((parts[0]==='self' || parts[0]==='cls') && owner.className) {
        tgt = funcByQual[`${owner.className}.${short}`]||null;
      }
      if (!tgt) {
        const candidates = funcByShort[short]||[];
        if (candidates.length===1) tgt=candidates[0];
        else if (parts.length>1) {
          const module = parts[0];
          tgt = candidates.find(f=>f.file.replace(/\.py$/,'')===module) || null;
        }
        if (!tgt && candidates.length>0) tgt=candidates[0];
      }
      if (tgt) {
        const recursive = (owner.id===tgt.id);
        resolved.push({ source: owner.id, target: tgt.id, line: c.line, recursive });
      }
    });
  });
  return resolved;
}

// ─── Dagre initial positions ──────────────────────────────────────────────────
function dagrePositions(allFiles) {
  const g = new dagre.graphlib.Graph();
  g.setGraph({ rankdir:'LR', ranksep:80, nodesep:20, edgesep:12, marginx:40, marginy:40 });
  g.setDefaultEdgeLabel(()=>({}));

  const colorMap={};
  Object.keys(allFiles).forEach((fn,i) => colorMap[fn]=FILE_COLORS[i%FILE_COLORS.length]);

  Object.values(allFiles).forEach(({filename,functions}) => {
    functions.forEach(f => {
      const w = Math.max(f.name.length*CHAR_W+PAD_X*2, NODE_MIN_W);
      g.setNode(f.id, {width:w, height:NODE_H});
    });
  });

  Object.values(allFiles).forEach(({calls}) => {
    // Resolve calls across files and add non-recursive edges to dagre graph
    const resolved = resolveCalls(allFiles);
    resolved.forEach(c => {
      if (!c.recursive && g.hasNode(c.source) && g.hasNode(c.target))
        g.setEdge(c.source, c.target);
    });
  });

  dagre.layout(g);

  const pos={};
  g.nodes().forEach(id => { const n=g.node(id); if(n) pos[id]={x:n.x,y:n.y}; });
  return {pos, colorMap};
}

// ─── Build data model ─────────────────────────────────────────────────────────
function buildData(allFiles) {
  const {pos, colorMap} = dagrePositions(allFiles);

  const nodes=[], nodeMap={};
  Object.values(allFiles).forEach(({filename,functions}) => {
    functions.forEach(f => {
      const savedPos = S.savedPositions && S.savedPositions[f.id];
      const p = savedPos ? {x: savedPos.x, y: savedPos.y} : (pos[f.id] || {x:Math.random()*600+100,y:Math.random()*400+100});
      const w = Math.max(f.name.length*CHAR_W+PAD_X*2, NODE_MIN_W);
      const nd = {
        id:f.id, name:f.name, file:filename, line:f.line,
        isMethod:f.isMethod, className:f.className, recursive:!!f.recursive,
        color:colorMap[filename], w, h:NODE_H,
        x:p.x, y:p.y, fx: savedPos && savedPos.fx!=null ? savedPos.fx : null, fy: savedPos && savedPos.fy!=null ? savedPos.fy : null,
      };
      nodes.push(nd); nodeMap[f.id]=nd;
    });
  });

  const edges=[], recursiveCalls=[];
  // Resolve calls across all files into concrete edges (and recursive loops)
  const resolvedCalls = resolveCalls(allFiles);
  resolvedCalls.forEach(c => {
    if (c.recursive) { recursiveCalls.push(c); return; }
    const s=nodeMap[c.source], t=nodeMap[c.target];
    if (!s||!t) return;
    const type = s.file===t.file ? 'internal' : 'external';
    edges.push({source:s,target:t,type});
  });

  // File color map (for clusters)
  const fileColors={};
  Object.keys(allFiles).forEach((fn,i)=>fileColors[fn]=FILE_COLORS[i%FILE_COLORS.length]);

  return {nodes, nodeMap, edges, recursiveCalls, fileColors};
}

// ─── Cluster bbox from current node positions ─────────────────────────────────
function clusterBBox(nodes, filename) {
  const members = nodes.filter(n=>n.file===filename);
  if (!members.length) return null;
  const minX = Math.min(...members.map(n=>n.x-n.w/2)) - CLUSTER_PAD;
  const minY = Math.min(...members.map(n=>n.y-n.h/2)) - CLUSTER_PAD;
  const maxX = Math.max(...members.map(n=>n.x+n.w/2)) + CLUSTER_PAD;
  const maxY = Math.max(...members.map(n=>n.y+n.h/2)) + CLUSTER_PAD + 14;
  return {x:minX, y:minY, w:maxX-minX, h:maxY-minY};
}

// ─── Cluster-overlap repulsion force ─────────────────────────────────────────
// Pushes nodes of different files apart when their cluster boxes would overlap.
function clusterRepulsionForce(nodes, fileNames, alpha) {
  // Compute current cluster bboxes
  const boxes = {};
  fileNames.forEach(fn => { boxes[fn]=clusterBBox(nodes,fn); });

  // For each pair of files check if bboxes overlap; if so push nodes apart
  for (let a=0;a<fileNames.length;a++) {
    for (let b=a+1;b<fileNames.length;b++) {
      const fa=fileNames[a], fb=fileNames[b];
      const ba=boxes[fa], bb=boxes[fb];
      if (!ba||!bb) continue;

      // AABB overlap detection + gap
      const GAP = 30;
      const overlapX = (ba.x+ba.w+GAP) - bb.x;
      const overlapY = (ba.y+ba.h+GAP) - bb.y;
      if (overlapX<=0||overlapY<=0) continue;
      const overlapX2 = (bb.x+bb.w+GAP) - ba.x;
      const overlapY2 = (bb.y+bb.h+GAP) - ba.y;
      if (overlapX2<=0||overlapY2<=0) continue;

      // Push along axis of minimum penetration
      const cax=ba.x+ba.w/2, cay=ba.y+ba.h/2;
      const cbx=bb.x+bb.w/2, cby=bb.y+bb.h/2;
      const dx=cbx-cax, dy=cby-cay;
      const dist=Math.sqrt(dx*dx+dy*dy)||1;

      // Penetration depth on each axis
      const penX=Math.min(overlapX,overlapX2);
      const penY=Math.min(overlapY,overlapY2);

      // Push strength proportional to overlap
      const str=alpha*0.4;
      let fx=0,fy=0;
      if (penX<penY) {
        fx=(dx>0?1:-1)*penX*str;
      } else {
        fy=(dy>0?1:-1)*penY*str;
      }

      // Apply equally-opposite to all nodes in each cluster
      const nodesA=nodes.filter(n=>n.file===fa);
      const nodesB=nodes.filter(n=>n.file===fb);
      nodesA.forEach(n=>{ n.vx-=fx; n.vy-=fy; });
      nodesB.forEach(n=>{ n.vx+=fx; n.vy+=fy; });
    }
  }
}

// ─── Cluster cohesion force ───────────────────────────────────────────────────
// Gently pulls nodes of the same file toward their cluster centroid.
function clusterCohesionForce(nodes, fileNames, alpha) {
  const STR = 0.06 * alpha;
  fileNames.forEach(fn => {
    const members=nodes.filter(n=>n.file===fn);
    if (members.length<2) return;
    const cx=members.reduce((s,n)=>s+n.x,0)/members.length;
    const cy=members.reduce((s,n)=>s+n.y,0)/members.length;
    members.forEach(n=>{ n.vx+=(cx-n.x)*STR; n.vy+=(cy-n.y)*STR; });
  });
}

// ─── Render ───────────────────────────────────────────────────────────────────
function renderGraph() {
  // Stop any running simulation
  if (S.sim) { S.sim.stop(); S.sim=null; }

  const svg = d3.select('#graph-svg');
  svg.selectAll('*').remove();
  S.nodeSelMap={}; S.clusterSelMap={}; S.linkSelArr=[];

  const fileNames = Object.keys(S.files);
  document.getElementById('emptyState').style.display = fileNames.length?'none':'flex';
  if (!fileNames.length) return;

  const {nodes, nodeMap, edges, recursiveCalls, fileColors} = buildData(S.files);
  S.nodes=nodes; S.edges=edges; S.recursiveCalls=recursiveCalls;

  const W=svg.node().clientWidth||900;
  const H=svg.node().clientHeight||700;

  // ── Defs / markers ─────────────────────────────────────────────────────────
  const defs=svg.append('defs');
  [['internal','#3ecfb0'],['external','#7c6aff'],['recursive','#ff7b5a']].forEach(([t,c])=>{
    defs.append('marker').attr('id',`arr-${t}`)
      .attr('viewBox','0 0 10 10').attr('refX',7).attr('refY',5)
      .attr('markerWidth',5).attr('markerHeight',5).attr('orient','auto-start-reverse')
      .append('path').attr('d','M2 2 L8 5 L2 8')
      .attr('fill','none').attr('stroke',c).attr('stroke-width',1.7)
      .attr('stroke-linecap','round').attr('stroke-linejoin','round');
  });

  // ── Zoom / pan ─────────────────────────────────────────────────────────────
  const g=svg.append('g');
  const zoom=d3.zoom().scaleExtent([0.04,4])
    .on('zoom',e=>g.attr('transform',e.transform));
  svg.call(zoom).on('dblclick.zoom',null);
  S.zoom=zoom; S.svgSel=svg; S.gSel=g;
  // If an imported state provided a zoom, apply it now
  if (S.savedZoom) {
    try {
      const t = d3.zoomIdentity.translate(S.savedZoom.x, S.savedZoom.y).scale(S.savedZoom.k||1);
      S.svgSel.call(S.zoom.transform, t);
    } catch(e) { /* ignore */ }
    S.savedZoom = null;
  }

  // ── Layer order: clusters → edges → nodes ─────────────────────────────────
  const clusterLayer = g.append('g').attr('class','clusters');
  const edgeLayer    = g.append('g').attr('class','edges');
  const nodeLayer    = g.append('g').attr('class','nodes');

  // ── Cluster rects (one per file) ───────────────────────────────────────────
  fileNames.forEach(fn=>{
    const color=fileColors[fn];
    const grp=clusterLayer.append('g');
    const rect=grp.append('rect').attr('rx',11)
      .style('fill',color).style('fill-opacity',.04)
      .style('stroke',color).style('stroke-opacity',.2)
      .style('stroke-dasharray','5 4').style('stroke-width',1);
    const label=grp.append('text')
      .style('fill',color).style('opacity',.5)
      .style('font-size','10px').style('font-family','Courier New,monospace')
      .style('pointer-events','none').text(fn);
    S.clusterSelMap[fn]={grp,rect,label};

    // Make the whole cluster draggable: dragging the cluster moves all its nodes
    grp.style('cursor','move').call(d3.drag()
      .on('start', function(ev){
        if (!ev.active && S.sim) S.sim.alphaTarget(0.15).restart();
        // Pin all member nodes at their current positions
        (S.nodes||[]).filter(n=>n.file===fn).forEach(n=>{ n.fx = n.x; n.fy = n.y; });
      })
      .on('drag', function(ev){
        const dx = ev.dx || 0, dy = ev.dy || 0;
        (S.nodes||[]).filter(n=>n.file===fn).forEach(n=>{
          // Ensure fx/fy are set, then offset by the drag delta
          n.fx = (n.fx!=null ? n.fx : n.x) + dx;
          n.fy = (n.fy!=null ? n.fy : n.y) + dy;
        });
      })
      .on('end', function(ev){
        if (!ev.active && S.sim) S.sim.alphaTarget(0);
        // leave nodes pinned where dropped
      })
    );
  });

  // ── Edges ──────────────────────────────────────────────────────────────────
  edges.forEach(e=>{
    const col=e.type==='external'?'#7c6aff':'#3ecfb0';
    const path=edgeLayer.append('path')
      .attr('fill','none').attr('stroke',col)
      .attr('stroke-width',1.5).attr('stroke-opacity',e.type==='external'?.4:.5)
      .attr('marker-end',`url(#arr-${e.type})`);
    S.linkSelArr.push({sel:path, s:e.source, t:e.target});
  });

  // Recursive loops (static shape relative to node, updated in tick)
  recursiveCalls.forEach(c=>{
    const n=nodeMap[c.source]; if (!n) return;
    const path=edgeLayer.append('path')
      .attr('fill','none').attr('stroke','#ff7b5a')
      .attr('stroke-width',1.5).attr('stroke-opacity',.6)
      .attr('stroke-dasharray','4 3')
      .attr('marker-end','url(#arr-recursive)');
    S.linkSelArr.push({sel:path, s:n, t:null, recursive:true});
  });

  // ── Nodes ──────────────────────────────────────────────────────────────────
  const tooltip=document.getElementById('tooltip');
  const canvasEl=document.getElementById('canvasArea');
  const inDeg={},outDeg={};
  edges.forEach(e=>{outDeg[e.source.id]=(outDeg[e.source.id]||0)+1; inDeg[e.target.id]=(inDeg[e.target.id]||0)+1;});

  nodes.forEach(n=>{
    const grp=nodeLayer.append('g').style('cursor','pointer');

    grp.append('rect')
      .attr('width',n.w).attr('height',n.h).attr('rx',5)
      .style('fill',`${n.color}15`).style('stroke',n.color)
      .style('stroke-width',n.recursive?2:1.2)
      .style('stroke-dasharray',n.recursive?'4 2':'none')
      .on('mousemove',function(ev){
        const cr=canvasEl.getBoundingClientRect();
        tooltip.innerHTML=`
          <div class="tooltip-name" style="color:${n.color}">${n.name}</div>
          <div class="tooltip-file">${n.file} · línea ${n.line}</div>
          <div class="tooltip-row"><span>entrantes</span><span>${inDeg[n.id]||0}</span></div>
          <div class="tooltip-row"><span>salientes</span><span>${outDeg[n.id]||0}</span></div>
          ${n.recursive?`<div class="tooltip-row"><span style="color:#ff7b5a">↻ recursiva</span></div>`:''}
        `;
        const tx=ev.clientX-cr.left+13, ty2=ev.clientY-cr.top-8;
        tooltip.style.left=`${Math.min(tx,cr.width-240)}px`;
        tooltip.style.top=`${Math.max(ty2,6)}px`;
        tooltip.style.opacity=1;
      })
      .on('mouseleave',()=>{tooltip.style.opacity=0;});

    grp.append('text')
      .attr('x',n.w/2).attr('y',n.h/2)
      .attr('text-anchor','middle').attr('dominant-baseline','central')
      .style('fill',n.color).style('font-size','11px')
      .style('font-family','Courier New,monospace').style('pointer-events','none')
      .text(n.name);

    if (n.recursive)
      grp.append('circle').attr('cx',n.w-5).attr('cy',5).attr('r',3).style('fill','#ff7b5a');

    // Drag: pin during drag, release after
    grp.call(d3.drag()
      .on('start',function(ev){
        if (!ev.active&&S.sim) S.sim.alphaTarget(0.15).restart();
        n.fx=n.x; n.fy=n.y;
      })
      .on('drag',function(ev){ n.fx=ev.x-n.w/2; n.fy=ev.y-n.h/2; })
      .on('end',function(ev){
        if (!ev.active&&S.sim) S.sim.alphaTarget(0);
        // Keep pinned after drag so it stays where dropped
        n.fx=n.x; n.fy=n.y;
      })
    );

    S.nodeSelMap[n.id]=grp;
  });

  // ── Force simulation ────────────────────────────────────────────────────────
  // Nodes use top-left origin internally; D3 force uses center — we adjust in tick.
  // We pass node objects directly; D3 mutates .x/.y/.vx/.vy on them.

  // Separate link objects (D3 needs plain {source,target} refs)
  const linkObjs = edges.map(e=>({source:e.source,target:e.target,type:e.type}));

  S.sim = d3.forceSimulation(nodes)
    .force('link', d3.forceLink(linkObjs)
      .id(d=>d.id)
      .distance(d=>d.type==='internal'?90:160)
      .strength(d=>d.type==='internal'?0.3:0.12)
    )
    .force('charge', d3.forceManyBody()
      .strength(-260)
      .distanceMax(350)
    )
    .force('collide', d3.forceCollide()
      .radius(d=>Math.max(d.w,d.h)/2+14)  // half-diagonal + gap
      .strength(1)
      .iterations(3)
    )
    .force('center', d3.forceCenter(W/2,H/2).strength(0.03))
    .force('clusterCohesion', customForce)
    .alphaDecay(0.015)
    .velocityDecay(0.45)
    .on('tick', onTick);

  function customForce(alpha) {
    clusterCohesionForce(nodes, fileNames, alpha);
    clusterRepulsionForce(nodes, fileNames, alpha);
  }

  function onTick() {
    // Update node positions (nodes stored with top-left, D3 gives center)
    nodes.forEach(n=>{
      const grp=S.nodeSelMap[n.id];
      if (grp) grp.attr('transform',`translate(${n.x-n.w/2},${n.y-n.h/2})`);
    });

    // Update edges: draw straight lines between node centers,
    // offset endpoints to node boundary so arrows don't overlap rects
    S.linkSelArr.forEach(({sel,s,t,recursive})=>{
      if (recursive) {
        // Self-loop on node s
        const n=s;
        const lx=n.x+n.w/2, ty2=n.y-n.h/2;
        sel.attr('d',`M${lx-5},${ty2} C${lx+30},${ty2-40} ${lx+50},${ty2-20} ${lx+5},${ty2}`);
        return;
      }
      // Straight line clipped to node boundaries
      const sx=s.x, sy=s.y, tx2=t.x, ty3=t.y;
      const dx=tx2-sx, dy=ty3-sy;
      const dist=Math.sqrt(dx*dx+dy*dy)||1;
      // Approximate boundary offset (half-extent in direction of edge)
      const offS=edgeOffset(s,dx/dist,dy/dist);
      const offT=edgeOffset(t,-dx/dist,-dy/dist);
      sel.attr('d',`M${sx+dx/dist*offS},${sy+dy/dist*offS} L${tx2-dx/dist*offT},${ty3-dy/dist*offT}`);
    });

    // Update cluster bboxes
    fileNames.forEach(fn=>{
      const bb=clusterBBox(nodes,fn);
      if (!bb) return;
      const {rect,label}=S.clusterSelMap[fn];
      rect.attr('x',bb.x).attr('y',bb.y).attr('width',bb.w).attr('height',bb.h);
      label.attr('x',bb.x+9).attr('y',bb.y+bb.h-7);
    });
  }

  fitGraph(false);
  // Clear saved positions after first render so new uploads behave normally
  S.savedPositions = null;
}

// Compute how far along the (nx,ny) unit vector we need to travel from the
// node center to reach the node's rectangular boundary.
function edgeOffset(node, nx, ny) {
  const hw=node.w/2+2, hh=node.h/2+2;
  if (Math.abs(nx)<1e-9&&Math.abs(ny)<1e-9) return 0;
  const tx=nx>0 ? hw/nx : nx<0 ? -hw/nx : Infinity;
  const ty=ny>0 ? hh/ny : ny<0 ? -hh/ny : Infinity;
  return Math.min(Math.abs(tx),Math.abs(ty));
}

// ─── Controls ─────────────────────────────────────────────────────────────────
function relayout() {
  // Unpin all nodes and re-run dagre positions, then restart sim
  if (!Object.keys(S.files).length) return;
  renderGraph(); // full re-render resets positions from dagre
}

function fitGraph(animated=true) {
  if (!S.svgSel||!S.zoom||!S.gSel) return;
  const svgEl=S.svgSel.node(), gEl=S.gSel.node();
  if (!gEl) return;
  const W=svgEl.clientWidth, H=svgEl.clientHeight;
  const bb=gEl.getBBox();
  if (!bb.width||!bb.height) return;
  const scale=Math.min(.9*W/bb.width,.9*H/bb.height,1.8);
  const tx=W/2-scale*(bb.x+bb.width/2), ty=H/2-scale*(bb.y+bb.height/2);
  const t=d3.zoomIdentity.translate(tx,ty).scale(scale);
  (animated?S.svgSel.transition().duration(380):S.svgSel).call(S.zoom.transform,t);
}

function zoomIn()  { S.svgSel?.transition().duration(180).call(S.zoom.scaleBy,1.5); }
function zoomOut() { S.svgSel?.transition().duration(180).call(S.zoom.scaleBy,0.66); }

// ─── State export / import ─────────────────────────────────────────────────
function exportState() {
  const payload = { files: S.files || {} };
  const positions = {};
  if (S.nodes) S.nodes.forEach(n=>{ positions[n.id]={x:n.x,y:n.y,fx:n.fx,fy:n.fy}; });
  payload.positions = positions;
  try {
    const z = d3.zoomTransform(S.svgSel.node()); payload.zoom = {x: z.x, y: z.y, k: z.k};
  } catch(e) { payload.zoom = null; }
  downloadJSON(payload, 'pygraph-state.json');
}

function downloadJSON(obj, name) {
  const blob = new Blob([JSON.stringify(obj, null, 2)], {type:'application/json'});
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a'); a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(()=>URL.revokeObjectURL(url), 5000);
}

function handleStateFiles(files) {
  if (!files || !files.length) return;
  const r = new FileReader();
  r.onload = e => { try { const obj = JSON.parse(e.target.result); importState(obj); } catch(err){ alert('JSON inválido'); } };
  r.readAsText(files[0]);
}

function importState(obj) {
  if (!obj) return;
  S.files = obj.files || {};
  S.savedPositions = obj.positions || null;
  S.savedZoom = obj.zoom || null;
  updateSidebar();
  renderGraph();
}

function saveLocalState() {
  const payload = { files: S.files || {} };
  const positions = {};
  if (S.nodes) S.nodes.forEach(n=>{ positions[n.id]={x:n.x,y:n.y,fx:n.fx,fy:n.fy}; });
  payload.positions = positions;
  try { const z = d3.zoomTransform(S.svgSel.node()); payload.zoom = {x:z.x,y:z.y,k:z.k}; } catch(e){ payload.zoom=null; }
  try { localStorage.setItem('pygraph.state', JSON.stringify(payload)); alert('estado guardado localmente'); } catch(e){ alert('no se pudo guardar en localStorage'); }
}

function loadLocalState() {
  try {
    const raw = localStorage.getItem('pygraph.state');
    if (!raw) { alert('no hay estado guardado'); return; }
    const obj = JSON.parse(raw); importState(obj);
  } catch(e) { alert('error al cargar estado local'); }
}

// ─── Files ────────────────────────────────────────────────────────────────────
function isPythonFilePath(path) {
  return /\.py$/i.test(path || '');
}

function readFileText(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = e => resolve(e.target.result || '');
    r.onerror = () => reject(new Error('error leyendo archivo'));
    r.readAsText(file);
  });
}

async function loadPythonEntries(entries) {
  if (!entries || !entries.length) return;
  const pyEntries = entries.filter(e => e && e.file && isPythonFilePath(e.displayName || e.file.name));
  if (!pyEntries.length) return;

  const parsed = await Promise.all(pyEntries.map(async entry => {
    const content = await readFileText(entry.file);
    const filename = entry.displayName || entry.file.webkitRelativePath || entry.file.name;
    return { filename, parsed: parsePythonFile(content, filename) };
  }));

  parsed.forEach(({filename, parsed}) => { S.files[filename] = parsed; });
  updateSidebar();
  renderGraph();
}

async function handleFiles(files) {
  const entries = Array.from(files || []).map(file => ({
    file,
    displayName: file.webkitRelativePath || file.name,
  }));
  await loadPythonEntries(entries);
}

function readAllDirectoryEntries(reader) {
  return new Promise((resolve, reject) => {
    const all = [];
    function nextChunk() {
      reader.readEntries(entries => {
        if (!entries.length) {
          resolve(all);
          return;
        }
        all.push(...entries);
        nextChunk();
      }, reject);
    }
    nextChunk();
  });
}

function fileFromEntry(entry) {
  return new Promise(resolve => {
    entry.file(resolve, () => resolve(null));
  });
}

async function collectPythonEntriesFromFsEntry(entry, prefix = '') {
  if (!entry) return [];

  const currentPath = prefix ? `${prefix}/${entry.name}` : entry.name;
  if (entry.isFile) {
    if (!isPythonFilePath(currentPath)) return [];
    const file = await fileFromEntry(entry);
    return file ? [{ file, displayName: currentPath }] : [];
  }

  if (!entry.isDirectory) return [];
  const reader = entry.createReader();
  const children = await readAllDirectoryEntries(reader);
  const nested = await Promise.all(children.map(child => collectPythonEntriesFromFsEntry(child, currentPath)));
  return nested.flat();
}

async function handleDropEvent(ev) {
  ev.preventDefault();

  const dataTransfer = ev.dataTransfer;
  const items = Array.from(dataTransfer?.items || []);
  const supportsEntries = items.some(it => typeof it.webkitGetAsEntry === 'function');

  if (supportsEntries) {
    const roots = items
      .map(it => it.webkitGetAsEntry())
      .filter(Boolean);
    const nested = await Promise.all(roots.map(root => collectPythonEntriesFromFsEntry(root)));
    await loadPythonEntries(nested.flat());
    return;
  }

  await handleFiles(dataTransfer?.files || []);
}
function removeFile(fn) { delete S.files[fn]; updateSidebar(); renderGraph(); }
function resetGraph()   { S.files={}; updateSidebar(); renderGraph(); }

function updateSidebar() {
  const names=Object.keys(S.files);
  const allF=names.reduce((a,n)=>a+S.files[n].functions.length,0);
  const allE=names.reduce((a,n)=>a+S.files[n].calls.length,0);
  document.getElementById('statsRow').style.display=names.length?'grid':'none';
  document.getElementById('statFiles').textContent=names.length;
  document.getElementById('statFuncs').textContent=allF;
  document.getElementById('statEdges').textContent=allE;
  const list=document.getElementById('fileList');
  if (!names.length) { list.innerHTML='<div style="font-size:10px;color:var(--muted);padding:8px;text-align:center;font-family:var(--font)">sin archivos</div>'; return; }
  list.innerHTML=names.map((n,i)=>{
    const col=FILE_COLORS[i%FILE_COLORS.length];
    return `<div class="file-item">
      <div class="file-item-left"><div class="file-dot" style="background:${col}"></div><span class="file-name" title="${n}">${n}</span></div>
      <span class="file-badge">${S.files[n].functions.length}</span>
      <button class="remove-file" onclick="removeFile('${n}')" title="eliminar">×</button>
    </div>`;
  }).join('');
}

// ─── Drag & drop ──────────────────────────────────────────────────────────────
const dz=document.getElementById('dropZone');
dz.addEventListener('dragover',e=>{e.preventDefault();dz.classList.add('drag-over');});
dz.addEventListener('dragleave',()=>dz.classList.remove('drag-over'));
dz.addEventListener('drop',async e=>{dz.classList.remove('drag-over'); await handleDropEvent(e);});
document.getElementById('canvasArea').addEventListener('dragover',e=>e.preventDefault());
document.getElementById('canvasArea').addEventListener('drop',async e=>{await handleDropEvent(e);});

// ─── Demo ─────────────────────────────────────────────────────────────────────
const DEMO=`# demo.py
class Animal:
    def __init__(self, name):
        self.name = name
        self.validate(name)

    def validate(self, name):
        if not name:
            raise ValueError("required")

    def speak(self):
        return self.sound()

    def sound(self):
        return "..."

class Dog(Animal):
    def sound(self):
        return "Woof"

    def fetch(self, item):
        self.speak()
        return self.retrieve(item)

    def retrieve(self, item):
        return item

class Cat(Animal):
    def sound(self):
        return "Meow"

    def purr(self):
        self.speak()

def train(animal, command):
    result = execute_command(animal, command)
    log_training(command, result)
    return result

def execute_command(animal, command):
    if command == "speak":
        return animal.speak()
    return None

def log_training(command, result):
    format_log(command, result)

def format_log(command, result):
  return f"{command}: {result}"
`;
const HELPERS=`# helpers.py
def format_log(command, result):
    return f"{command}: {result}"

def log_training(command, result):
    format_log(command, result)

def execute_command(animal, command):
    if command == "speak":
        return animal.speak()
    return None
`;

const EXTRAS=`# extras.py
from demo import Dog
import helpers

def make_dog(name):
    return Dog(name)

def train_all():
    d = make_dog("Rex")
    res = helpers.execute_command(d, "speak")
    helpers.log_training("speak", res)
    return res
`;

(function(){
  S.files['demo.py']=parsePythonFile(DEMO,'demo.py');
  S.files['helpers.py']=parsePythonFile(HELPERS,'helpers.py');
  S.files['extras.py']=parsePythonFile(EXTRAS,'extras.py');
  updateSidebar();
  setTimeout(renderGraph,130);
})();
