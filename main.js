// ============================================================
// UI CONTROLLER
// ============================================================

let adv = null;
let ui = {};
let currentCheckIndex = 0;
let eventCheckResults = [];
let pendingOutcomeEffects = null;
let awaitingPhase = null; // sub-phase within a day

// ── Init ──────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  ui = {
    // panels
    partyPanel: document.getElementById('party-panel'),
    itemsPanel: document.getElementById('items-panel'),
    mainArea: document.getElementById('main-area'),
    logPanel: document.getElementById('log-panel'),
    dayCounter: document.getElementById('day-counter'),
    weightDisplay: document.getElementById('weight-display'),
    foodDisplay: document.getElementById('food-display'),
    // log
    logList: document.getElementById('log-list'),
  };

  adv = createDemoAdventure();
  renderAll();
  showPhaseStart();
});

// ── Render ─────────────────────────────────────────────────────
function renderAll() {
  renderParty();
  renderItems();
  renderStats();
}

function renderStats() {
  const cap = adv.getWeightCapacity();
  const cur = adv.getCurrentWeight();
  ui.dayCounter.textContent = `第 ${adv.day} / ${adv.days_max} 日`;
  ui.weightDisplay.textContent = `负重 ${cur}/${cap}`;
  ui.foodDisplay.textContent = `干粮 ${adv.getFood()}`;
}

function renderParty() {
  ui.partyPanel.innerHTML = '';
  for (const a of adv.adventurers) {
    const card = document.createElement('div');
    const derivedClass = a.status === STATUS.DEAD ? 'dead'
      : a.status === STATUS.MISSING ? 'missing'
      : a.injury > 0 ? 'injured' : 'alive';
    card.className = 'char-card ' + derivedClass;
    const hpMax = a.hpMax();
    const hpPct = hpMax > 0 ? (a.hp / hpMax) * 100 : 0;
    const hpColor = hpPct > 60 ? 'var(--hp-high)' : hpPct > 30 ? 'var(--hp-mid)' : 'var(--hp-low)';

    const statusLabel = a.status === STATUS.DEAD ? '【亡】'
      : a.status === STATUS.MISSING ? '【失】'
      : a.injury > 0 ? '【伤】' : '';

    const attrs = Object.entries(a.attrs).map(([k, v]) => `${k}${v}`).join(' ');
    const injuryBar = a.injury > 0
      ? `<div class="char-injury">伤 ${a.injury}/${a.sta}</div>`
      : '';

    card.innerHTML = `
      <div class="char-name">${statusLabel}${a.name}</div>
      <div class="char-hp-bar">
        <div class="char-hp-fill" style="width:${hpPct}%;background:${hpColor}"></div>
        ${a.injury > 0 ? `<div class="char-injury-fill" style="width:${(a.injury/a.sta)*100}%"></div>` : ''}
      </div>
      <div class="char-hp-text">HP ${a.hp}/${hpMax}${a.injury > 0 ? `　伤${a.injury}` : ''}</div>
      ${attrs ? `<div class="char-attrs">${attrs}</div>` : ''}
      ${a.skill ? `<div class="char-skill">◆ ${a.skill}</div>` : ''}
    `;
    ui.partyPanel.appendChild(card);
  }
}

function renderItems() {
  ui.itemsPanel.innerHTML = '';
  for (const item of adv.items) {
    const row = document.createElement('div');
    row.className = 'item-row';
    const bonuses = Object.entries(item.props)
      .filter(([k]) => !['isdrug','isfood','hp回复量'].includes(k))
      .map(([k, v]) => `${k}+${v}`).join(' ');

    row.innerHTML = `
      <span class="item-name">${item.name}</span>
      <span class="item-qty">×${item.quantity}</span>
      ${bonuses ? `<span class="item-bonus">${bonuses}</span>` : ''}
      <div class="item-actions">
        ${item.consumable ? `<button class="btn-small btn-use" onclick="handleUseItem('${item.id}')">用</button>` : ''}
        <button class="btn-small btn-drop" onclick="handleDropItem('${item.id}')">丢</button>
      </div>
    `;
    ui.itemsPanel.appendChild(row);
  }
}

function renderLog() {
  ui.logList.innerHTML = '';
  const recent = adv.log.slice(-40).reverse();
  for (const entry of recent) {
    const li = document.createElement('div');
    li.className = 'log-entry';
    li.textContent = entry;
    ui.logList.appendChild(li);
  }
}

function statusClass(s) {
  return { 1: 'alive', 0: 'injured', '-1': 'missing', '-2': 'dead' }[s] || 'alive';
}

// ── Main area rendering ────────────────────────────────────────
function setMain(html) {
  ui.mainArea.innerHTML = html;
}

function addLog(msg) {
  adv.log.push(msg);
  renderLog();
}

// ── Phase: Start ──────────────────────────────────────────────
function showPhaseStart() {
  adv.phase = PHASE.START;
  const partyStat = `武力${adv.getPartyStat('str')} 智力${adv.getPartyStat('int')}`;
  setMain(`
    <div class="phase-box">
      <div class="phase-title">队伍集结</div>
      <div class="phase-body">
        <p>当前队伍检定属性：<strong>${partyStat}</strong></p>
        <p>负重上限：${adv.getWeightCapacity()}，当前：${adv.getCurrentWeight()}</p>
        <p>阮、未二人带伤同行，检定时不计其属性。</p>
      </div>
      <div class="phase-actions">
        <button class="btn-primary" onclick="startDay()">启程 →</button>
      </div>
    </div>
  `);
  renderAll();
  renderLog();
}

// ── Phase: New Day ─────────────────────────────────────────────
function startDay() {
  adv.day++;
  currentCheckIndex = 0;
  eventCheckResults = [];
  pendingOutcomeEffects = null;

  if (adv.day > adv.days_max) {
    showEnd();
    return;
  }

  adv.log.push(`\n── 第 ${adv.day} 日 ──`);

  const event = adv.drawEvent();
  if (!event) {
    addLog('【事件】无可用事件，平安度过。');
    showConsumePhase();
    return;
  }

  adv.current_event = event;
  adv.event_history.push(event.id);

  // apply intro effects if any
  if (event.intro_effects) {
    adv.applyEffects(event.intro_effects);
    renderAll();
  }

  // handle different event types
  if (event.loot) {
    showLootPhase(event);
  } else if (event.recruit) {
    showRecruitPhase(event);
  } else if (event.checks && event.checks.length > 0) {
    showEventIntro(event);
  } else {
    // pure text event
    showEventIntro(event);
  }
}

function showEventIntro(event) {
  adv.phase = PHASE.EVENT_INTRO;
  const partyStat = `武力 ${adv.getPartyStat('str')}　智力 ${adv.getPartyStat('int')}`;
  setMain(`
    <div class="phase-box">
      <div class="day-badge">第 ${adv.day} 日</div>
      <div class="event-name">◈ ${event.name}</div>
      <div class="event-intro">${event.intro}</div>
      <div class="party-stats-bar">当前队伍：${partyStat}</div>
      <div class="phase-actions">
        ${event.checks && event.checks.length > 0
          ? `<button class="btn-primary" onclick="doNextCheck()">应对 →</button>`
          : `<button class="btn-primary" onclick="showConsumePhase()">继续 →</button>`
        }
      </div>
    </div>
  `);
  renderAll();
  renderLog();
}

// ── Phase: Check ──────────────────────────────────────────────
function doNextCheck() {
  const event = adv.current_event;
  if (currentCheckIndex >= event.checks.length) {
    showConsumePhase();
    return;
  }

  const check = event.checks[currentCheckIndex];
  adv.phase = PHASE.CHECK;

  const playerVal = adv.getPartyStat(check.stat);
  const enemyVal = check.difficulty || 0;

  setMain(`
    <div class="phase-box">
      <div class="event-name">◈ ${event.name}</div>
      <div class="check-label">${check.label}</div>
      <div class="dice-arena">
        <div class="dice-side">
          <div class="dice-title">我方 ${check.stat} × ${playerVal}</div>
          <div class="dice-pool" id="dice-player"></div>
          <div class="dice-score" id="score-player">-</div>
        </div>
        <div class="dice-vs">対</div>
        <div class="dice-side">
          <div class="dice-title">对方 × ${enemyVal}</div>
          <div class="dice-pool" id="dice-enemy"></div>
          <div class="dice-score" id="score-enemy">-</div>
        </div>
      </div>
      <div class="phase-actions">
        <button class="btn-primary" id="roll-btn" onclick="rollCheck()">掷骰</button>
      </div>
    </div>
  `);
  renderAll();
}

function rollCheck() {
  const event = adv.current_event;
  const check = event.checks[currentCheckIndex];
  const result = adv.resolveCheck(check);
  eventCheckResults.push(result);

  // animate dice
  const playerPool = document.getElementById('dice-player');
  const enemyPool = document.getElementById('dice-enemy');
  const scorePlayer = document.getElementById('score-player');
  const scoreEnemy = document.getElementById('score-enemy');
  const rollBtn = document.getElementById('roll-btn');
  if (rollBtn) rollBtn.disabled = true;

  // render dice with animation
  renderDice(playerPool, result.player_roll.rolls, result.player_val);
  renderDice(enemyPool, result.enemy_roll.rolls, result.enemy_val);

  setTimeout(() => {
    if (scorePlayer) scorePlayer.textContent = result.player_roll.sum;
    if (scoreEnemy) scoreEnemy.textContent = result.enemy_roll.sum;

    const outcome = result.success ? '成功' : '失败';
    const outcomeClass = result.success ? 'success' : 'failure';

    const outcomeDiv = document.createElement('div');
    outcomeDiv.className = `check-outcome ${outcomeClass}`;
    outcomeDiv.textContent = `【${outcome}】${result.success ? check.success_text : check.failure_text}`;
    document.querySelector('.phase-box').insertBefore(outcomeDiv, document.querySelector('.phase-actions'));

    // show effect messages
    const effects = result.success ? check.success_effects : check.failure_effects;
    const msgs = adv.applyEffects(effects);
    if (msgs.length) {
      const efDiv = document.createElement('div');
      efDiv.className = 'effect-list';
      efDiv.innerHTML = msgs.map(m => `<span class="effect-tag">${m}</span>`).join('');
      document.querySelector('.phase-box').insertBefore(efDiv, document.querySelector('.phase-actions'));
    }

    renderAll();
    renderLog();

    // handle fail_ends_event
    if (!result.success && check.fail_ends_event) {
      document.querySelector('.phase-actions').innerHTML =
        `<button class="btn-primary" onclick="showConsumePhase()">继续 →</button>`;
      return;
    }

    currentCheckIndex++;
    document.querySelector('.phase-actions').innerHTML =
      currentCheckIndex < event.checks.length
        ? `<button class="btn-primary" onclick="doNextCheck()">下一检定 →</button>`
        : `<button class="btn-primary" onclick="showConsumePhase()">结算 →</button>`;

    if (adv.phase === PHASE.BAD_END) {
      document.querySelector('.phase-actions').innerHTML =
        `<button class="btn-danger" onclick="showBadEnd()">…</button>`;
    }
  }, 800);
}

function renderDice(container, rolls, total) {
  container.innerHTML = '';
  if (total === 0) {
    const empty = document.createElement('span');
    empty.className = 'dice-empty';
    empty.textContent = '无';
    container.appendChild(empty);
    return;
  }
  for (const r of rolls) {
    const d = document.createElement('span');
    d.className = `die die-${r}`;
    d.textContent = r;
    container.appendChild(d);
    // stagger animation
    d.style.animationDelay = `${Math.random() * 0.3}s`;
  }
}

// ── Phase: Loot ───────────────────────────────────────────────
function showLootPhase(event) {
  adv.phase = PHASE.LOOT_SELECT;
  adv.pending_loot = event.loot;
  const cap = adv.getWeightCapacity() - adv.getCurrentWeight();

  let itemsHtml = event.loot.map(item => {
    const totalW = item.weight * item.quantity;
    return `
      <label class="loot-item">
        <input type="checkbox" value="${item.id}" data-weight="${totalW}" onchange="updateLootWeight()">
        <span>${item.name} ×${item.quantity}</span>
        <span class="loot-weight">重${totalW}</span>
      </label>
    `;
  }).join('');

  setMain(`
    <div class="phase-box">
      <div class="day-badge">第 ${adv.day} 日</div>
      <div class="event-name">◈ ${event.name}</div>
      <div class="event-intro">${event.intro}</div>
      <div class="loot-capacity">剩余负重：<span id="cap-remaining">${cap}</span> / ${adv.getWeightCapacity()}</div>
      <div class="loot-list">${itemsHtml}</div>
      <div class="phase-actions">
        <button class="btn-primary" onclick="confirmLoot()">带走选中物资</button>
        <button class="btn-secondary" onclick="showConsumePhase()">放弃</button>
      </div>
    </div>
  `);
}

function updateLootWeight() {
  const checks = document.querySelectorAll('.loot-item input:checked');
  let used = 0;
  checks.forEach(c => used += parseInt(c.dataset.weight));
  const cap = adv.getWeightCapacity() - adv.getCurrentWeight();
  const rem = document.getElementById('cap-remaining');
  if (rem) rem.textContent = cap - used;
}

function confirmLoot() {
  const checks = document.querySelectorAll('.loot-item input:checked');
  const ids = Array.from(checks).map(c => c.value);
  adv.confirmLoot(ids);
  renderAll();
  showConsumePhase();
}

// ── Phase: Recruit ────────────────────────────────────────────
function showRecruitPhase(event) {
  adv.phase = PHASE.RECRUIT;
  const r = event.recruit;
  const attrs = [];
  if (r.str) attrs.push(`武力 ${r.str}`);
  if (r.int) attrs.push(`智力 ${r.int}`);
  setMain(`
    <div class="phase-box">
      <div class="day-badge">第 ${adv.day} 日</div>
      <div class="event-name">◈ ${event.name}</div>
      <div class="event-intro">${event.intro}</div>
      <div class="recruit-card">
        <div class="recruit-name">${r.name}</div>
        <div class="recruit-attrs">体力上限 ${r.sta}　${attrs.join('　')}</div>
        ${r.skill ? `<div class="recruit-skill">◆ ${r.skill}</div>` : ''}
      </div>
      <div class="phase-actions">
        <button class="btn-primary" onclick="handleRecruit(true)">收入队伍</button>
        <button class="btn-secondary" onclick="handleRecruit(false)">离开</button>
      </div>
    </div>
  `);
}

function handleRecruit(yes) {
  adv.pending_recruit = adv.current_event.recruit;
  adv.confirmRecruit(yes);
  renderAll();
  showConsumePhase();
}

// ── Phase: Wound Roll ─────────────────────────────────────────
function showWoundRollPhase() {
  adv.phase = PHASE.WOUND_ROLL;
  const injured = adv.injuredAdventurers();

  if (!injured.length) {
    showConsumePhase2();
    return;
  }

  setMain(`
    <div class="phase-box">
      <div class="phase-title">伤势检定</div>
      <div class="phase-body">
        <p>受伤的队员需要进行伤势检定。</p>
        <div id="wound-results"></div>
      </div>
      <div class="phase-actions">
        <button class="btn-primary" onclick="doWoundRolls()">检定</button>
      </div>
    </div>
  `);
}

function doWoundRolls() {
  const results = adv.woundRolls();
  const container = document.getElementById('wound-results');
  if (container) {
    container.innerHTML = results.map(r => {
      const cls = r.outcome === 'recover' ? 'success'
        : (r.outcome === 'dead') ? 'failure'
        : r.outcome === 'worsen' ? 'failure'
        : 'neutral';
      const lastWords = r.outcome === 'dead' && adv.adventurers.find(a => a.name === r.name)?.last_words;
      return `<div class="wound-result ${cls}">
        【${r.name}】掷${r.roll} → ${r.msg}
        ${lastWords ? `<div class="last-words">「${lastWords}」</div>` : ''}
      </div>`;
    }).join('');
  }
  renderAll();
  renderLog();

  document.querySelector('.phase-actions').innerHTML =
    `<button class="btn-primary" onclick="showConsumePhase2()">继续 →</button>`;

  if (adv.phase === PHASE.BAD_END) {
    document.querySelector('.phase-actions').innerHTML =
      `<button class="btn-danger" onclick="showBadEnd()">…</button>`;
  }
}

// ── Phase: Consume ────────────────────────────────────────────
function showConsumePhase() {
  // first do wound rolls
  showWoundRollPhase();
}

function showConsumePhase2() {
  adv.phase = PHASE.CONSUME;
  const deaths = adv.dailyConsume();

  const deathHtml = deaths.length ? `
    <div class="starvation-deaths">
      ${deaths.map(a => `
        <div class="wound-result failure">
          【${a.name}】体力耗尽，倒下了
          ${a.last_words ? `<div class="last-words">「${a.last_words}」</div>` : ''}
        </div>
      `).join('')}
    </div>
  ` : '';

  const zhiResult = adv.zhiSkillTrigger();
  renderAll();

  // collect evening speeches from alive members
  const speeches = [];
  for (const a of adv.aliveAdventurers()) {
    const line = getEveningSpeech(a);
    if (line) speeches.push({ name: a.name, line, injured: a.isInjured() });
  }
  // shuffle and take up to 4
  speeches.sort(() => Math.random() - 0.5);
  const shown = speeches.slice(0, 4);

  const zhiHtml = zhiResult
    ? `<div class="skill-notice">◆ 黹：「${zhiResult.speech}」采集到 ${zhiResult.qty} 份草药</div>`
    : '';

  const speechHtml = shown.length ? `
    <div class="evening-speeches">
      ${shown.map(s => `
        <div class="speech-entry ${s.injured ? 'speech-injured' : ''}">
          <span class="speech-name">${s.name}</span>
          <span class="speech-line">「${s.line}」</span>
        </div>
      `).join('')}
    </div>
  ` : '';

  setMain(`
    <div class="phase-box">
      <div class="phase-title">日暮</div>
      <div class="phase-body">
        <p>奔波一日，每人消耗1点体力。可在右侧物资栏手动使用干粮和草药。</p>
        ${zhiHtml}
        <p>干粮剩余：<strong>${adv.getFood()}</strong>　存活：${adv.aliveAdventurers().length} 人</p>
      </div>
      ${deathHtml}
      ${speechHtml}
      <div class="phase-actions">
        <button class="btn-primary" onclick="endDay()">次日 →</button>
      </div>
    </div>
  `);
  renderLog();
}

function endDay() {
  if (adv.phase === PHASE.BAD_END) { showBadEnd(); return; }
  if (adv.day >= adv.days_max) { showEnd(); return; }
  startDay();
}

// ── Phase: End ────────────────────────────────────────────────
function showEnd() {
  adv.phase = PHASE.END;
  setMain(`
    <div class="phase-box end-box">
      <div class="phase-title">旅途终结</div>
      <div class="phase-body">
        <p>历经 ${adv.days_max} 日跋涉，队伍抵达目的地。</p>
        <p>存活：${adv.aliveAdventurers().map(a => a.name).join('、') || '无'}</p>
        <p>剩余干粮：${adv.getFood()}</p>
        <p class="end-note">（此处将根据最终数值分流剧情结局）</p>
      </div>
      <div class="phase-actions">
        <button class="btn-primary" onclick="resetGame()">重新开始</button>
      </div>
    </div>
  `);
  renderLog();
}

function showBadEnd() {
  adv.phase = PHASE.BAD_END;
  setMain(`
    <div class="phase-box bad-end-box">
      <div class="phase-title">全队覆灭</div>
      <div class="phase-body">
        <p>无人生还。</p>
      </div>
      <div class="phase-actions">
        <button class="btn-primary" onclick="resetGame()">重新开始</button>
      </div>
    </div>
  `);
  renderLog();
}

function resetGame() {
  adv = createDemoAdventure();
  renderAll();
  renderLog();
  showPhaseStart();
}

// ── Item handlers ─────────────────────────────────────────────
function handleUseItem(id) {
  const res = adv.useItem(id);
  renderAll();
  renderLog();
  if (!res.ok) {
    showToast(res.msg);
  }
}

function handleDropItem(id) {
  adv.dropItem(id);
  renderAll();
  renderLog();
}

function showToast(msg) {
  let t = document.getElementById('toast');
  if (!t) {
    t = document.createElement('div');
    t.id = 'toast';
    document.body.appendChild(t);
  }
  t.textContent = msg;
  t.classList.add('show');
  setTimeout(() => t.classList.remove('show'), 2000);
}
