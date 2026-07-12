// Seeds a local dev Kanboard with realistic dummy data via the Application API.
// Usage: node docker/seed.mjs   (after `docker compose up -d`)
//
// Auth: HTTP Basic "jsonrpc:<API_AUTHENTICATION_TOKEN>" against /jsonrpc.php.
// The token is fixed in docker/config.php for local dev only.

const BASE = process.env.KANBOARD_URL || 'http://localhost:8080';
const TOKEN = process.env.KANBOARD_API_TOKEN || 'devtoken-local-only';
const ENDPOINT = `${BASE.replace(/\/+$/, '')}/jsonrpc.php`;
const AUTH = 'Basic ' + Buffer.from(`jsonrpc:${TOKEN}`).toString('base64');

let _id = 0;

async function rpc(method, params = {}) {
  _id += 1;
  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: AUTH },
    body: JSON.stringify({ jsonrpc: '2.0', id: _id, method, params }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} on ${method}`);
  const json = await res.json();
  if (json.error) {
    throw new Error(`RPC ${method} failed: ${JSON.stringify(json.error)}`);
  }
  return json.result;
}

async function waitForServer(maxSeconds = 90) {
  process.stdout.write('Waiting for Kanboard');
  for (let i = 0; i < maxSeconds; i++) {
    try {
      const v = await rpc('getVersion');
      process.stdout.write(`\nKanboard is up (version ${v}).\n`);
      return;
    } catch {
      process.stdout.write('.');
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
  throw new Error('\nKanboard did not become reachable in time.');
}

function daysFromNow(n) {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return d.toISOString().slice(0, 10); // YYYY-MM-DD
}

const COLORS = ['yellow', 'blue', 'green', 'red', 'purple', 'orange', 'pink', 'teal'];
const SEED_MARKER = 'Home Renovation';

async function projectExists(name) {
  const projects = await rpc('getAllProjects');
  return Array.isArray(projects) && projects.some((p) => p.name === name);
}

// Create a project and return { id, columns: [{id,title}], swimlanes, categories }.
async function makeProject(name, description, { extraColumns = [], swimlanes = [], categories = [] } = {}) {
  const id = await rpc('createProject', { name, description });
  if (!id) throw new Error(`createProject returned falsy id for "${name}"`);

  // Admin (user 1) must be a project member before it can own tasks.
  await rpc('addProjectUser', { project_id: id, user_id: 1, role: 'project-manager' });

  for (const title of extraColumns) {
    await rpc('addColumn', { project_id: id, title });
  }
  const swimlaneIds = {};
  for (const sName of swimlanes) {
    swimlaneIds[sName] = await rpc('addSwimlane', { project_id: id, name: sName });
  }
  const categoryIds = {};
  for (const cName of categories) {
    categoryIds[cName] = await rpc('createCategory', { project_id: id, name: cName });
  }
  const columns = await rpc('getColumns', { project_id: id });
  return { id, columns, swimlaneIds, categoryIds };
}

async function makeTask(project, columnIndex, title, opts = {}) {
  const col = project.columns[Math.min(columnIndex, project.columns.length - 1)];
  const params = {
    title,
    project_id: project.id,
    column_id: col.id,
    owner_id: 1, // admin
    color_id: opts.color || COLORS[Math.floor(Math.random() * COLORS.length)],
    ...opts.extra,
  };
  if (opts.dueInDays !== undefined) params.date_due = daysFromNow(opts.dueInDays);
  if (opts.priority !== undefined) params.priority = opts.priority;
  if (opts.description) params.description = opts.description;
  if (opts.categoryId) params.category_id = opts.categoryId;
  if (opts.swimlaneId) params.swimlane_id = opts.swimlaneId;

  const taskId = await rpc('createTask', params);
  if (!taskId) throw new Error(`createTask returned falsy id for "${title}"`);

  for (const st of opts.subtasks || []) {
    await rpc('createSubtask', { task_id: taskId, title: st });
  }
  for (const c of opts.comments || []) {
    await rpc('createComment', { task_id: taskId, user_id: 1, content: c });
  }
  return taskId;
}

async function main() {
  await waitForServer();

  if (await projectExists(SEED_MARKER)) {
    console.log(`Seed marker project "${SEED_MARKER}" already exists — skipping (already seeded).`);
    console.log('To reseed: `npm run kanboard:reset && npm run kanboard:up` then run seed again.');
    return;
  }

  let tasks = 0;
  let subtasks = 0;
  let comments = 0;
  const bump = (t) => {
    tasks += 1;
    subtasks += (t.subtasks || []).length;
    comments += (t.comments || []).length;
  };

  // --- Project 1: Home Renovation ---
  const reno = await makeProject(
    SEED_MARKER,
    'Tracking the apartment renovation, room by room.',
    {
      swimlanes: ['Kitchen', 'Bathroom'],
      categories: ['Plumbing', 'Electrical', 'Painting', 'Furniture'],
    }
  );
  const renoTasks = [
    { col: 0, title: 'Get quotes from 3 contractors', dueInDays: 5, priority: 2, color: 'red',
      categoryId: reno.categoryIds['Plumbing'],
      description: 'Compare pricing and timelines before committing.',
      subtasks: ['Email contractor A', 'Email contractor B', 'Call contractor C'],
      comments: ['Contractor A responded, waiting on the other two.'] },
    { col: 0, title: 'Choose kitchen tile', dueInDays: 12, color: 'yellow',
      swimlaneId: reno.swimlaneIds['Kitchen'], categoryId: reno.categoryIds['Painting'],
      subtasks: ['Visit showroom', 'Order samples'] },
    { col: 1, title: 'Rewire bathroom lighting', dueInDays: 3, priority: 3, color: 'orange',
      swimlaneId: reno.swimlaneIds['Bathroom'], categoryId: reno.categoryIds['Electrical'],
      description: 'Need an inspection after the rewire.',
      comments: ['Permit approved on Monday.'] },
    { col: 1, title: 'Replace kitchen faucet', color: 'blue',
      swimlaneId: reno.swimlaneIds['Kitchen'], categoryId: reno.categoryIds['Plumbing'],
      subtasks: ['Buy faucet', 'Shut off water', 'Install'] },
    { col: 2, title: 'Paint living room', dueInDays: -2, priority: 1, color: 'green',
      categoryId: reno.categoryIds['Painting'],
      description: 'Two coats of eggshell white.' },
    { col: 2, title: 'Assemble new bookshelf', color: 'purple',
      categoryId: reno.categoryIds['Furniture'],
      subtasks: ['Unbox', 'Build frame', 'Mount to wall'] },
    { col: 3, title: 'Demolish old cabinets', color: 'teal',
      swimlaneId: reno.swimlaneIds['Kitchen'],
      comments: ['Done — debris hauled away.'] },
    { col: 3, title: 'Order paint supplies', color: 'pink' },
  ];
  for (const t of renoTasks) { await makeTask(reno, t.col, t.title, t); bump(t); }

  // --- Project 2: Side Project ---
  const side = await makeProject(
    'Side Project',
    'Building a small weather app on weekends.',
    {
      extraColumns: ['Code Review'],
      categories: ['Frontend', 'Backend', 'Bug'],
    }
  );
  const sideTasks = [
    { col: 0, title: 'Design the settings screen', dueInDays: 8, color: 'blue',
      categoryId: side.categoryIds['Frontend'],
      subtasks: ['Sketch layout', 'Pick color palette'] },
    { col: 0, title: 'Set up CI pipeline', priority: 2, color: 'yellow',
      categoryId: side.categoryIds['Backend'] },
    { col: 1, title: 'Fix temperature unit toggle', dueInDays: 1, priority: 3, color: 'red',
      categoryId: side.categoryIds['Bug'],
      description: 'Toggling °C/°F sometimes shows stale value.',
      comments: ['Reproduced on Safari only.'] },
    { col: 1, title: 'Cache API responses offline', color: 'green',
      categoryId: side.categoryIds['Backend'],
      subtasks: ['Add service worker', 'Test airplane mode'] },
    { col: 2, title: 'Refactor fetch layer', color: 'purple',
      categoryId: side.categoryIds['Frontend'] },
    { col: 3, title: 'Add dark mode', dueInDays: -5, color: 'teal',
      categoryId: side.categoryIds['Frontend'],
      comments: ['Shipped in v0.3.'] },
    { col: 4, title: 'Write README', color: 'pink' },
  ];
  for (const t of sideTasks) { await makeTask(side, t.col, t.title, t); bump(t); }

  // --- Project 3: Personal ---
  const personal = await makeProject(
    'Personal',
    'Errands, appointments, and life admin.',
    { categories: ['Health', 'Finance', 'Errands'] }
  );
  const personalTasks = [
    { col: 0, title: 'Book dentist appointment', dueInDays: 4, priority: 2, color: 'red',
      categoryId: personal.categoryIds['Health'] },
    { col: 0, title: 'Renew car insurance', dueInDays: 10, color: 'yellow',
      categoryId: personal.categoryIds['Finance'],
      subtasks: ['Compare quotes', 'Cancel old policy'] },
    { col: 0, title: 'Buy birthday gift for Sam', dueInDays: 6, color: 'pink',
      categoryId: personal.categoryIds['Errands'] },
    { col: 1, title: 'File taxes', dueInDays: 2, priority: 3, color: 'orange',
      categoryId: personal.categoryIds['Finance'],
      description: 'Gather W-2 and receipts first.',
      subtasks: ['Collect documents', 'Fill forms', 'Submit'],
      comments: ['Accountant says deadline is firm.'] },
    { col: 1, title: 'Meal prep for the week', color: 'green',
      categoryId: personal.categoryIds['Health'] },
    { col: 2, title: 'Schedule annual checkup', color: 'blue',
      categoryId: personal.categoryIds['Health'] },
    { col: 3, title: 'Return library books', color: 'teal',
      categoryId: personal.categoryIds['Errands'],
      comments: ['Returned all three.'] },
  ];
  for (const t of personalTasks) { await makeTask(personal, t.col, t.title, t); bump(t); }

  console.log('\nSeed complete:');
  console.log(`  Projects:  3 (Home Renovation, Side Project, Personal)`);
  console.log(`  Tasks:     ${tasks}`);
  console.log(`  Subtasks:  ${subtasks}`);
  console.log(`  Comments:  ${comments}`);
  console.log(`\nKanboard UI: ${BASE}  (admin / admin)`);
}

main().catch((err) => {
  console.error('\nSeed failed:', err.message);
  process.exit(1);
});
