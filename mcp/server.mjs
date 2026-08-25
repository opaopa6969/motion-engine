#!/usr/bin/env node
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import {
  MotionEngine, Gesture, ArmAct, RootAct, Reach, Place, Pick, Grip,
  solveTwoBone, gripPose, ARM_ACTS, ROOT_ACTS, PLACE_STYLES, MANAGED,
} from '../index.js';

const VERSION = '0.12.0';
const NAME = 'motion-engine';

function log(...a) { process.stderr.write('[motion-mcp] ' + a.map((x) => typeof x === 'string' ? x : JSON.stringify(x)).join(' ') + '\n'); }

const Vec3 = z.array(z.number()).length(3);
const Vec4 = z.array(z.number()).length(4);

function gestureNames() {
  const names = [];
  for (const n of ['tsumogiri','headScratch','fistPump','slump','recoil','crossArms','nod','shrug','lean','smirkTilt','sigh','exhale','yareyare','headShakeRue']) {
    const g = new Gesture(n);
    if (!g.done) names.push(n);
  }
  return names;
}

function makeAction(type, name, params) {
  params = params || {};
  switch (type) {
    case 'gesture':
      return new Gesture(name, params.dur, params.env);
    case 'reach':
      return new Reach(params.side || 'right', params.geo, params.target, params.dur, params.opts);
    case 'place':
      return new Place(params.side || 'right', params.geo, params.target, params.opts);
    case 'pick':
      return new Pick(params.side || 'right', params.geo, params.opts);
    case 'armAct':
      return new ArmAct(name, params.geo, params.dur);
    case 'rootAct':
      return new RootAct(name, params.dur);
    case 'grip':
      return new Grip(params.side || 'right', params.opts);
    default:
      throw new Error(`unknown action type: ${type}`);
  }
}

export function createServer() {
  const server = new McpServer({ name: NAME, version: VERSION });
  const engines = new Map();

  function getEngine(sessionId) {
    if (!sessionId) return null;
    if (!engines.has(sessionId)) {
      engines.set(sessionId, new MotionEngine());
    }
    return engines.get(sessionId);
  }

  server.tool(
    'step',
    'Advance one frame and return Pose (debug/verification use; real renderers use import). Stateful within a session.',
    {
      dt: z.number().positive(),
      ctx: z.object({
        t: z.number().optional(),
        phase: z.number().optional(),
        pose: z.record(z.string(), Vec3).optional(),
        poseW: z.number().optional(),
        gain: z.number().optional(),
      }).optional(),
    },
    async (args, extra) => {
      const sid = extra?.sessionId;
      const engine = getEngine(sid);
      if (!engine) {
        return { isError: true, content: [{ type: 'text', text: 'no session — call within an MCP session' }] };
      }
      const pose = engine.update(args.dt, args.ctx || {});
      return { content: [{ type: 'text', text: JSON.stringify({ pose }) }] };
    },
  );

  server.tool(
    'play',
    'Queue a transient action (gesture/reach/place/pick/armAct/rootAct/grip). Stateful within a session.',
    {
      action: z.object({
        type: z.enum(['gesture', 'reach', 'place', 'pick', 'armAct', 'rootAct', 'grip']),
        name: z.string().optional(),
        params: z.record(z.string(), z.any()).optional(),
      }),
    },
    async (args, extra) => {
      const sid = extra?.sessionId;
      const engine = getEngine(sid);
      if (!engine) {
        return { isError: true, content: [{ type: 'text', text: 'no session — call within an MCP session' }] };
      }
      try {
        const action = makeAction(args.action.type, args.action.name, args.action.params);
        engine.play(action);
        return { content: [{ type: 'text', text: JSON.stringify({ queued: true, actions_in_queue: engine.actions.length }) }] };
      } catch (e) {
        return { isError: true, content: [{ type: 'text', text: String(e.message || e) }] };
      }
    },
  );

  server.tool(
    'clear',
    'Clear the action queue. Stateful within a session.',
    {},
    async (args, extra) => {
      const sid = extra?.sessionId;
      const engine = getEngine(sid);
      if (!engine) {
        return { isError: true, content: [{ type: 'text', text: 'no session — call within an MCP session' }] };
      }
      engine.clear();
      return { content: [{ type: 'text', text: JSON.stringify({ cleared: true }) }] };
    },
  );

  server.tool(
    'solve_ik',
    'Solve 2-bone IK (stateless pure function). Returns upper/lower quaternions.',
    {
      pU: Vec3, pL: Vec3, pH: Vec3,
      restU: Vec3, restL: Vec3,
      target: Vec3,
      pole: Vec3.optional(),
      elbow: Vec3.optional(),
      shoulder: Vec3.optional(),
    },
    async (args) => {
      const { upperQ, lowerQ } = solveTwoBone(
        args.pU, args.pL, args.pH,
        args.restU, args.restL, args.target,
        { pole: args.pole, elbow: args.elbow, shoulder: args.shoulder },
      );
      return { content: [{ type: 'text', text: JSON.stringify({ upperQ, lowerQ }) }] };
    },
  );

  server.tool(
    'grip_pose',
    'Generate finger grip Pose for one hand (stateless pure function). curl 0=open, ~1=firm grip.',
    {
      side: z.enum(['left', 'right']),
      curl: z.number(),
      flexSign: z.number().optional(),
    },
    async (args) => {
      const bone = gripPose(args.side, args.curl, { flexSign: args.flexSign });
      return { content: [{ type: 'text', text: JSON.stringify({ bone }) }] };
    },
  );

  server.tool(
    'list_acts',
    'List action vocabulary: gestures, arm_acts, root_acts, place_styles.',
    {},
    async () => {
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            gestures: gestureNames(),
            arm_acts: Object.keys(ARM_ACTS),
            root_acts: Object.keys(ROOT_ACTS),
            place_styles: Object.keys(PLACE_STYLES),
          }),
        }],
      };
    },
  );

  server.resource('spec', 'motion://spec', { mimeType: 'application/json', description: 'Machine-readable capability spec' }, async () => {
    const spec = {
      namespace: 'motion',
      name: NAME,
      version: VERSION,
      summary: 'Procedural human-motion engine for VRM avatars — Pose generation, action vocabulary, 2-bone IK, finger grip.',
      capabilities: [
        { kind: 'tool', name: 'step', summary: 'Advance one frame, return Pose', input: '{dt, ctx?}', output: '{pose:{bone,root}}', side_effect: 'read', long_running: false, dry_run: false, min_role: 'MEMBER' },
        { kind: 'tool', name: 'play', summary: 'Queue a transient action', input: '{action:{type,name,params}}', output: '{queued,actions_in_queue}', side_effect: 'write', long_running: false, dry_run: false, min_role: 'MEMBER' },
        { kind: 'tool', name: 'clear', summary: 'Clear action queue', input: '{}', output: '{cleared}', side_effect: 'write', long_running: false, dry_run: false, min_role: 'MEMBER' },
        { kind: 'tool', name: 'solve_ik', summary: 'Solve 2-bone IK', input: '{pU,pL,pH,restU,restL,target,pole?,elbow?,shoulder?}', output: '{upperQ,lowerQ}', side_effect: 'none', long_running: false, dry_run: false, min_role: 'MEMBER' },
        { kind: 'tool', name: 'grip_pose', summary: 'Generate finger grip Pose', input: '{side,curl,flexSign?}', output: '{bone}', side_effect: 'none', long_running: false, dry_run: false, min_role: 'MEMBER' },
        { kind: 'tool', name: 'list_acts', summary: 'List action vocabulary', input: '{}', output: '{gestures,arm_acts,root_acts,place_styles}', side_effect: 'none', long_running: false, dry_run: false, min_role: 'VIEWER' },
        { kind: 'resource', name: 'spec', summary: 'This spec', input: '', output: 'JSON', side_effect: 'none' },
        { kind: 'resource', name: 'guide', summary: 'Usage guide', input: '', output: 'markdown', side_effect: 'none' },
        { kind: 'resource', name: 'pose_schema', summary: 'Pose format and full-body contract', input: '', output: 'JSON', side_effect: 'none' },
      ],
      compositions: [
        { title: 'skeleton plan → IK → physics → frame', flow: ['sotai__plan', 'motion__solve_ik', 'xpbd__solve', 'motion__step'], note: 'sotai skeleton → motion IK → xpbd physics → motion frame update' },
        { title: 'emotion → reaction', flow: ['affect__valence', 'motion__play', 'motion__step'], note: 'emotion value mapped to gesture gain' },
        { title: 'physio → modulation overlay', flow: ['physio__breath_phase', 'motion__step'], note: 'breath modulation overlaid as EmotionPose input' },
      ],
      depends_on: [
        { namespace: 'sotai', capability: 'sotai__plan' },
        { namespace: 'morpho', capability: 'morpho__toBodySpec' },
      ],
      health: '/healthz',
      docs: ['motion://guide', 'motion://pose_schema'],
    };
    return { contents: [{ uri: 'motion://spec', mimeType: 'application/json', text: JSON.stringify(spec, null, 2) }] };
  });

  server.resource('guide', 'motion://guide', { mimeType: 'text/markdown', description: 'Usage guide' }, async () => {
    const guide = `# motion-engine MCP Guide

## Overview
motion-engine is a procedural human-motion engine for VRM avatars. It generates Pose data (bone Euler rotations + root channels) every frame from springs, idle noise, emotion hints, and transient actions.

## State Model
MotionEngine is stateful (action queue + springs). MCP sessions hold one engine instance per \`mcp-session-id\`. Within a session, \`play\` → \`step\` calls are state-continuous. Stateless tools (\`solve_ik\`, \`grip_pose\`, \`list_acts\`) work without a session.

## Tools

### step
Advance one frame. Returns \`{pose}\` where pose is \`{bone: {[name]: [x,y,z]}, root: {y, z, tilt, lookDown}}\`.
- \`dt\`: frame delta time (seconds)
- \`ctx\`: optional \`{t, phase, pose, poseW, gain}\`
- **Use case**: debug/verification. Real renderers use direct import for performance.

### play
Queue an action. \`action: {type, name, params}\`.
- type=gesture: name from list_acts().gestures, params={dur?, env?}
- type=armAct: name from list_acts().arm_acts, params={geo:{right?,left?}, dur?}
- type=rootAct: name from list_acts().root_acts, params={dur?}
- type=reach: params={side, geo, target, dur?, opts?}
- type=place: params={side, geo, target, opts?}
- type=pick: params={side, geo, opts?}
- type=grip: params={side, opts?}

### clear
Clear the action queue.

### solve_ik
Stateless 2-bone IK. Input: upper/lower/hand positions, rest rotations, target. Output: upper/lower quaternions.

### grip_pose
Stateless finger grip Pose. Input: side, curl (0=open, ~1=firm). Output: 15 bone rotations.

### list_acts
Returns gesture/arm_act/root_act/place_style name lists.

## Resources
- \`motion://spec\` — machine-readable capability spec
- \`motion://pose_schema\` — Pose format and managed bone names
- \`motion://guide\` — this guide

## Composition
- \`sotai__plan → motion__solve_ik → xpbd__solve → motion__step\`
- \`affect__valence → motion__play(gesture:recoil, gain:2.0) → motion__step\`
- \`physio__breath_phase → motion__step(ctx:{pose:breathNudge, poseW:0.3})\`
`;
    return { contents: [{ uri: 'motion://guide', mimeType: 'text/markdown', text: guide }] };
  });

  server.resource('pose_schema', 'motion://pose_schema', { mimeType: 'application/json', description: 'Pose format and full-body contract' }, async () => {
    const schema = {
      description: 'Pose output format from MotionEngine.update()',
      bone_format: {
        type: 'object',
        properties: {},
        description: 'Each key is a VRM normalized bone name. Value is [x, y, z] Euler rotation in radians (bone-local space).',
      },
      root: {
        type: 'object',
        properties: {
          y: { type: 'number', description: 'vertical offset (meters)' },
          z: { type: 'number', description: 'forward/backward offset (meters)' },
          tilt: { type: 'number', description: 'lateral tilt (radians)' },
          lookDown: { type: 'number', description: 'gaze downward 0..1' },
        },
      },
      managed_bones: MANAGED,
      bone_count: MANAGED.length,
      coordinate_space: 'VRM normalized local Euler (radians)',
      note: 'Consumers that only read pose[boneName] are unaffected by root. root is opt-in.',
    };
    return { contents: [{ uri: 'motion://pose_schema', mimeType: 'application/json', text: JSON.stringify(schema, null, 2) }] };
  });

  return { server, engines };
}

async function serveHttp(port) {
  const transports = new Map();
  const httpServer = http.createServer(async (req, res) => {
    res.setHeader('content-encoding', 'identity');
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    try {
      if (url.pathname === '/healthz') {
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ ok: true, name: NAME, version: VERSION }));
      }
      if (url.pathname !== '/mcp') {
        res.writeHead(404, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ error: 'not found' }));
      }
      const sid = req.headers['mcp-session-id'];
      if (sid && transports.has(sid)) {
        return await transports.get(sid).handleRequest(req, res);
      }
      if (req.method === 'POST' && !sid) {
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          enableJsonResponse: true,
          onsessioninitialized: (id) => { transports.set(id, transport); log('session open', { sid: id }); },
          onsessionclosed: (id) => { transports.delete(id); log('session closed', { sid: id }); },
        });
        const { server, engines } = createServer();
        transport.onclose = () => {
          if (transport.sessionId) {
            engines.delete(transport.sessionId);
            transports.delete(transport.sessionId);
          }
          server.close().catch(() => {});
        };
        await server.connect(transport);
        return await transport.handleRequest(req, res);
      }
      res.writeHead(sid ? 404 : 400, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ error: sid ? 'unknown session' : 'missing mcp-session-id' }));
    } catch (e) {
      log('request failed', { path: url.pathname, error: String(e?.stack || e) });
      if (!res.headersSent) { res.writeHead(500); res.end(JSON.stringify({ error: 'internal error' })); }
      else res.end();
    }
  });
  const bindAddr = '0.0.0.0';
  httpServer.listen(port, bindAddr, () => log('http listening', { url: `http://${bindAddr}:${port}/mcp` }));
  return httpServer;
}

const argv = process.argv.slice(2);
if (argv.includes('--http')) {
  const port = Number(process.env.PORT || argv[argv.indexOf('--http') + 1] || 9201);
  serveHttp(port).catch((e) => { log('http failed', { error: String(e?.stack || e) }); process.exit(1); });
} else {
  process.stderr.write('usage: server.mjs --http [port]  (or set PORT env)\n');
  process.exit(2);
}
