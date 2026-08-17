const http = require('http');
const fs = require('fs');
const path = require('path');
const url = require('url');

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');
const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, 'data.json');

// ==================== 名额配置 ====================
const QUOTAS = {
  '2024级': { '1-1': 1, '1-2': 1, '1-3': 1, '2-1': 1, '2-2': 0, '2-3': 1 },
  '2025级': { '1-1': 2, '1-2': 2, '1-3': 2, '2-1': 2, '2-2': 2, '2-3': 2 },
  '2026级': { '1-1': 2, '1-2': 2, '1-3': 0, '2-1': 2, '2-2': 2, '2-3': 2 }
};
const ALL_GROUPS = ['1-1', '1-2', '1-3', '2-1', '2-2', '2-3'];
const GRADES = ['2024级', '2025级', '2026级'];
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123';

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
};

// ==================== 数据管理 ====================
// 双模式存储：设置了 DATABASE_URL 时使用 PostgreSQL（云部署），否则使用本地文件
const DATABASE_URL = process.env.DATABASE_URL;
let pgPool = null;

if (DATABASE_URL) {
  let pg;
  try {
    pg = require('pg');
  } catch (e) {
    console.error('错误: 已设置 DATABASE_URL 但未安装 pg 依赖，请运行 npm install');
    process.exit(1);
  }
  pgPool = new pg.Pool({ connectionString: DATABASE_URL, ssl: DATABASE_URL.includes('localhost') ? false : { rejectUnauthorized: false } });

  // 建表（带重试，等待数据库就绪）
  (async function initTable() {
    for (let i = 1; i <= 10; i++) {
      try {
        await pgPool.query(`
          CREATE TABLE IF NOT EXISTS draws (
            id SERIAL PRIMARY KEY,
            name TEXT UNIQUE NOT NULL,
            grade TEXT NOT NULL,
            "group" TEXT NOT NULL,
            drawn_at TIMESTAMPTZ NOT NULL DEFAULT now()
          )
        `);
        console.log('[数据库] PostgreSQL 连接成功，数据表已就绪');
        return;
      } catch (e) {
        console.log(`[数据库] 连接失败（第${i}次），${e.message}，5秒后重试...`);
        await new Promise(r => setTimeout(r, 5000));
      }
    }
    console.error('[数据库] 多次连接失败，退出');
    process.exit(1);
  })();
}

async function loadData() {
  if (pgPool) {
    const result = await pgPool.query('SELECT name, grade, "group", drawn_at AS timestamp FROM draws ORDER BY drawn_at');
    return { draws: result.rows };
  }
  try {
    const raw = fs.readFileSync(DATA_FILE, 'utf-8');
    const data = JSON.parse(raw);
    if (!data.draws) data.draws = [];
    return data;
  } catch {
    return { draws: [] };
  }
}

async function saveData(data) {
  if (pgPool) {
    const client = await pgPool.connect();
    try {
      await client.query('BEGIN');
      await client.query('DELETE FROM draws');
      for (const d of data.draws) {
        await client.query(
          'INSERT INTO draws (name, grade, "group", drawn_at) VALUES ($1, $2, $3, $4) ON CONFLICT (name) DO NOTHING',
          [d.name, d.grade, d.group, d.timestamp || new Date().toISOString()]
        );
      }
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
    return;
  }
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2), 'utf-8');
}

// PostgreSQL 模式下的原子抽签（事务 + 咨询锁，防止并发超抽）
async function pgDraw(name, grade) {
  const client = await pgPool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(94170817)');

    // 已抽过则直接返回
    const existing = await client.query('SELECT name, grade, "group", drawn_at AS timestamp FROM draws WHERE name = $1', [name]);
    if (existing.rowCount > 0) {
      await client.query('COMMIT');
      return { alreadyDrawn: true, draw: existing.rows[0] };
    }

    // 统计该年级各组已抽人数
    const counts = await client.query('SELECT "group", count(*)::int AS c FROM draws WHERE grade = $1 GROUP BY "group"', [grade]);
    const filledMap = {};
    for (const row of counts.rows) filledMap[row.group] = row.c;

    const available = [];
    for (const group of ALL_GROUPS) {
      if (QUOTAS[grade][group] > 0 && (filledMap[group] || 0) < QUOTAS[grade][group]) {
        available.push(group);
      }
    }
    if (available.length === 0) {
      await client.query('COMMIT');
      return { full: true };
    }

    const group = available[Math.floor(Math.random() * available.length)];
    await client.query('INSERT INTO draws (name, grade, "group") VALUES ($1, $2, $3)', [name, grade, group]);
    const totalDrawn = (await client.query('SELECT count(*)::int AS c FROM draws')).rows[0].c;
    await client.query('COMMIT');
    console.log(`[抽签] ${name} (${grade}) -> ${group} | 进度: ${totalDrawn}/27`);
    return { draw: { name, grade, group, timestamp: new Date().toISOString() }, totalDrawn };
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

function getFilledCounts(draws) {
  const filled = {};
  for (const grade of GRADES) {
    filled[grade] = {};
    for (const group of ALL_GROUPS) {
      filled[grade][group] = draws.filter(d => d.grade === grade && d.group === group).length;
    }
  }
  return filled;
}

function getAvailableGroups(grade, draws) {
  const available = [];
  for (const group of ALL_GROUPS) {
    const filled = draws.filter(d => d.grade === grade && d.group === group).length;
    const quota = QUOTAS[grade][group];
    if (quota > 0 && filled < quota) {
      available.push(group);
    }
  }
  return available;
}

// ==================== API 处理 ====================
async function handleStatus(res) {
  const data = await loadData();
  const filled = getFilledCounts(data.draws);
  const totalDrawn = data.draws.length;
  const totalQuota = 27;

  const gradeSummary = {};
  for (const grade of GRADES) {
    const drawn = data.draws.filter(d => d.grade === grade).length;
    const total = Object.values(QUOTAS[grade]).reduce((a, b) => a + b, 0);
    gradeSummary[grade] = { drawn, total, remaining: total - drawn };
  }

  res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify({
    quotas: QUOTAS,
    filled,
    totalDrawn,
    totalQuota,
    gradeSummary,
    isComplete: totalDrawn >= totalQuota
  }));
}

async function handleLookup(req, res, pathname) {
  const query = url.parse(req.url, true).query;
  const name = (query.name || '').trim();

  if (!name) {
    res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ success: false, error: '请提供姓名' }));
    return;
  }

  const data = await loadData();
  const draw = data.draws.find(d => d.name === name);

  if (draw) {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ success: true, ...draw }));
  } else {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ success: false }));
  }
}

async function handleDraw(req, res) {
  const body = await readBody(req);
  const name = (body.name || '').trim();
  const grade = (body.grade || '').trim();

  // 验证输入
  if (!name) {
    res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: '请输入姓名' }));
    return;
  }
  if (!GRADES.includes(grade)) {
    res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: '请选择有效的年级' }));
    return;
  }

  // PostgreSQL 模式：原子抽签
  if (pgPool) {
    const result = await pgDraw(name, grade);
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    if (result.alreadyDrawn) {
      res.end(JSON.stringify({ success: true, alreadyDrawn: true, ...result.draw }));
    } else if (result.full) {
      res.end(JSON.stringify({ error: '该年级名额已满，无法抽签' }));
    } else {
      res.end(JSON.stringify({ success: true, ...result.draw }));
    }
    return;
  }

  // 本地文件模式
  const data = await loadData();

  // 检查是否已抽过
  if (data.draws.some(d => d.name === name)) {
    const existing = data.draws.find(d => d.name === name);
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ success: true, alreadyDrawn: true, ...existing }));
    return;
  }

  // 查找可用的组别
  const available = getAvailableGroups(grade, data.draws);

  if (available.length === 0) {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: '该年级名额已满，无法抽签' }));
    return;
  }

  // 随机抽签
  const group = available[Math.floor(Math.random() * available.length)];

  const draw = {
    name,
    grade,
    group,
    timestamp: new Date().toISOString()
  };

  data.draws.push(draw);
  saveData(data);

  console.log(`[抽签] ${name} (${grade}) -> ${group} | 进度: ${data.draws.length}/27`);

  res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify({ success: true, ...draw }));
}

async function handleResults(res) {
  const data = await loadData();
  const filled = getFilledCounts(data.draws);

  // 构建矩阵表格数据
  const table = {};
  for (const group of ALL_GROUPS) {
    table[group] = {};
    for (const grade of GRADES) {
      const names = data.draws
        .filter(d => d.grade === grade && d.group === group)
        .map(d => d.name);
      table[group][grade] = {
        names,
        filled: names.length,
        quota: QUOTAS[grade][group]
      };
    }
  }

  const gradeSummary = {};
  for (const grade of GRADES) {
    const drawn = data.draws.filter(d => d.grade === grade).length;
    const total = Object.values(QUOTAS[grade]).reduce((a, b) => a + b, 0);
    gradeSummary[grade] = { drawn, total, remaining: total - drawn };
  }

  const groupSummary = {};
  for (const group of ALL_GROUPS) {
    let drawn = 0;
    let total = 0;
    for (const grade of GRADES) {
      drawn += filled[grade][group];
      total += QUOTAS[grade][group];
    }
    groupSummary[group] = { drawn, total };
  }

  res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify({
    draws: data.draws.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp)),
    table,
    gradeSummary,
    groupSummary,
    totalDrawn: data.draws.length,
    totalQuota: 27,
    isComplete: data.draws.length >= 27
  }));
}

async function handleReset(req, res) {
  const body = await readBody(req);
  const password = body.password || '';

  if (password !== ADMIN_PASSWORD) {
    res.writeHead(403, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: '密码错误' }));
    return;
  }

  await saveData({ draws: [] });
  console.log('[重置] 所有抽签数据已清除');

  res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify({ success: true }));
}

async function handleDelete(req, res) {
  const body = await readBody(req);
  const name = (body.name || '').trim();
  const password = body.password || '';

  if (password !== ADMIN_PASSWORD) {
    res.writeHead(403, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: '密码错误' }));
    return;
  }

  if (!name) {
    res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: '请提供姓名' }));
    return;
  }

  const data = await loadData();
  const before = data.draws.length;
  data.draws = data.draws.filter(d => d.name !== name);
  const after = data.draws.length;

  if (before === after) {
    res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: '未找到该姓名的抽签记录' }));
    return;
  }

  await saveData(data);
  console.log(`[删除] 已删除 ${name} 的抽签记录`);

  res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify({ success: true }));
}

// ==================== 工具函数 ====================
function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => { body += chunk.toString(); });
    req.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch {
        reject(new Error('Invalid JSON'));
      }
    });
    req.on('error', reject);
  });
}

function serveStaticFile(pathname, res) {
  // 特殊路由
  if (pathname === '/') pathname = '/index.html';
  if (pathname === '/admin') pathname = '/admin.html';

  const filePath = path.join(PUBLIC_DIR, pathname);

  // 防止目录遍历
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  const ext = path.extname(filePath);
  const contentType = MIME_TYPES[ext] || 'application/octet-stream';

  try {
    const content = fs.readFileSync(filePath);
    res.writeHead(200, { 'Content-Type': contentType });
    res.end(content);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end('<h1>404 - 页面不存在</h1>');
  }
}

// ==================== 服务器 ====================
const server = http.createServer(async (req, res) => {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(200);
    res.end();
    return;
  }

  const parsedUrl = url.parse(req.url, true);
  const pathname = parsedUrl.pathname;

  // API 路由
  if (pathname === '/api/status' && req.method === 'GET') {
    return handleStatus(res);
  }
  if (pathname === '/api/lookup' && req.method === 'GET') {
    return handleLookup(req, res, pathname);
  }
  if (pathname === '/api/draw' && req.method === 'POST') {
    try {
      return await handleDraw(req, res);
    } catch (e) {
      res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: '请求格式错误' }));
    }
    return;
  }
  if (pathname === '/api/results' && req.method === 'GET') {
    return handleResults(res);
  }
  if (pathname === '/api/reset' && req.method === 'POST') {
    try {
      return await handleReset(req, res);
    } catch (e) {
      res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: '请求格式错误' }));
    }
    return;
  }
  if (pathname === '/api/delete' && req.method === 'POST') {
    try {
      return await handleDelete(req, res);
    } catch (e) {
      res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: '请求格式错误' }));
    }
    return;
  }

  // 静态文件
  return serveStaticFile(pathname, res);
});

server.listen(PORT, '0.0.0.0', () => {
  console.log('========================================');
  console.log('  分组抽签系统已启动');
  console.log(`  抽签页面: http://localhost:${PORT}`);
  console.log(`  管理后台: http://localhost:${PORT}/admin`);
  console.log(`  管理密码: ${ADMIN_PASSWORD}`);
  console.log(`  存储模式: ${pgPool ? 'PostgreSQL（云端持久化）' : '本地文件'}`);
  console.log('========================================');
});
