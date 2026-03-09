const urlInput = document.getElementById('urlInput');
const checkBtn = document.getElementById('checkBtn');
const pauseBtn = document.getElementById('pauseBtn');
const stopBtn = document.getElementById('stopBtn');
const exportBtn = document.getElementById('exportBtn');
const brokenOnly = document.getElementById('brokenOnly');
const progressText = document.getElementById('progressText');
const statsText = document.getElementById('statsText');
const currentText = document.getElementById('currentText');
const progressBar = document.getElementById('progressBar');
const resultsBody = document.getElementById('resultsBody');

let scanId = null;
let eventSource = null;
let paused = false;
const rows = new Map();

function statusClass(status) {
  const lower = status.toLowerCase();
  if (lower.includes('checking')) return 'status-checking';
  if (lower.includes('ok')) return 'status-ok';
  if (lower.includes('redirect')) return 'status-redirect';
  return 'status-broken';
}

function isBroken(status) {
  const lower = status.toLowerCase();
  return lower.includes('timeout') || lower.includes('failed') || lower.includes('404') || lower.includes('500') || lower.includes('503');
}

function renderRow(data) {
  let tr = rows.get(data.id);
  if (!tr) {
    tr = document.createElement('tr');
    tr.dataset.id = data.id;
    tr.innerHTML = '<td></td><td></td><td></td>';
    rows.set(data.id, tr);
    resultsBody.appendChild(tr);
  }

  tr.children[0].textContent = data.status;
  tr.children[0].className = statusClass(data.status);
  tr.children[1].textContent = data.url;
  tr.children[2].textContent = data.sourceText;

  if (brokenOnly.checked && !isBroken(data.status)) {
    tr.style.display = 'none';
  } else {
    tr.style.display = '';
  }
}

async function startScan() {
  const url = urlInput.value.trim();
  if (!url) return;

  rows.clear();
  resultsBody.innerHTML = '';

  const mode = document.querySelector('input[name="mode"]:checked').value;
  const response = await fetch('/api/scan/start', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url, mode })
  });

  const data = await response.json();
  scanId = data.scanId;
  paused = false;

  pauseBtn.disabled = false;
  stopBtn.disabled = false;
  exportBtn.disabled = false;

  if (eventSource) eventSource.close();
  eventSource = new EventSource(`/api/scan/${scanId}/events`);

  eventSource.addEventListener('result', (event) => {
    const payload = JSON.parse(event.data);
    renderRow(payload);
  });

  eventSource.addEventListener('progress', (event) => {
    const payload = JSON.parse(event.data);
    progressBar.style.width = `${payload.percent}%`;
    progressText.textContent = `${payload.percent}% scanned - ${payload.checkedCount}/${payload.total} URLs checked`;
    statsText.textContent = `${payload.stats.ok} OK, ${payload.stats.failed} failed, ${payload.stats.redirect} redirect`;
    currentText.textContent = `Checking file: ${payload.currentItem || '-'}`;

    if (payload.state === 'completed' || payload.state === 'stopped') {
      pauseBtn.disabled = true;
      stopBtn.disabled = true;
    }
  });
}

checkBtn.addEventListener('click', () => {
  startScan().catch(console.error);
});

pauseBtn.addEventListener('click', async () => {
  if (!scanId) return;
  const action = paused ? 'resume' : 'pause';
  await fetch(`/api/scan/${scanId}/${action}`, { method: 'POST' });
  paused = !paused;
  pauseBtn.textContent = paused ? 'Resume' : 'Pause';
});

stopBtn.addEventListener('click', async () => {
  if (!scanId) return;
  await fetch(`/api/scan/${scanId}/stop`, { method: 'POST' });
});

exportBtn.addEventListener('click', () => {
  if (!scanId) return;
  window.open(`/api/scan/${scanId}/export.csv`, '_blank');
});

brokenOnly.addEventListener('change', () => {
  document.querySelectorAll('#resultsBody tr').forEach((tr) => {
    const status = tr.children[0].textContent;
    tr.style.display = brokenOnly.checked && !isBroken(status) ? 'none' : '';
  });
});
