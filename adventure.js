// ============================================================
// DATA STRUCTURES
// ============================================================

const STATUS = { ALIVE: 1, MISSING: -1, DEAD: -2 };
const PHASE = {
  START: 'start',
  EVENT_INTRO: 'event_intro',
  CHECK: 'check',
  LOOT_SELECT: 'loot_select',
  RECRUIT: 'recruit',
  WOUND_ROLL: 'wound_roll',
  CONSUME: 'consume',
  END: 'end',
  BAD_END: 'bad_end',
};

class Adventurer {
  constructor(data) {
    this.id     = data.id;
    this.name   = data.name;
    this.sta    = data.sta || 0;
    this.injury = data.injury || 0;
    this.hp     = data.hp !== undefined ? data.hp : Math.max(0, this.sta - this.injury);
    this.san    = data.san !== undefined ? data.san : 3;
    this.status = data.status !== undefined ? data.status : STATUS.ALIVE;
    this.attrs  = {};
    if (data.str) this.attrs.str = data.str;
    if (data.int) this.attrs.int = data.int;
    this.skill  = data.skill || null;
  }

  hpMax()    { return Math.max(0, this.sta - this.injury); }
  isActive() { return this.isAlive() && this.injury === 0; }
  isInjured(){ return this.isAlive() && this.injury > 0; }
  isAlive()  { return this.status !== STATUS.DEAD && this.status !== STATUS.MISSING; }

  getAttr(key) {
    if (!this.isActive()) return 0;
    return this.attrs[key] || 0;
  }

  clampHp() {
    this.hp = Math.min(this.hp, this.hpMax());
  }
}

class Item {
  constructor(data) {
    this.id        = data.id;
    this.name      = data.name;
    this.quantity  = data.quantity || 1;
    this.weight    = data.weight || 1;
    this.consumable= data.consumable || false;
    this.props     = {};
    const reserved = new Set(['id','name','quantity','weight','consumable']);
    for (const k in data) {
      if (!reserved.has(k)) this.props[k] = data[k];
    }
  }

  isDrug()      { return !!this.props.isdrug; }
  isFood()      { return !!this.props.isfood; }
  totalWeight() { return this.weight * this.quantity; }
}

class Adventure {
  constructor(data) {
    this.day          = 0;
    this.days_max     = data.days_max || 7;
    this.label_start  = data.label_start || '';
    this.label_end    = data.label_end || '';
    this.adventurers  = data.adventurers.map(a => new Adventurer(a));
    this.items        = (data.items || []).map(i => new Item(i));
    this.event_pool_static = [...(data.events || [])];
    this.event_pool   = [...(data.events || [])];
    this.event_history= [];
    this.log          = [];
    this.phase        = PHASE.START;
    this.current_event= null;
    this.pending_loot = null;
    this.pending_recruit = null;
  }

  // ── Party stats ─────────────────────────────────────────────
  getPartyStat(key) {
    let total = 0;
    for (const a of this.adventurers) {
      if (a.isActive()) total += (a.attrs[key] || 0);
    }
    for (const item of this.items) {
      if (item.props[key]) total += item.props[key] * item.quantity;
    }
    return total;
  }

  getWeightCapacity() {
    return this.adventurers.filter(a => a.isAlive()).reduce((s,a) => s + a.sta, 0);
  }

  getCurrentWeight() {
    return this.items.reduce((s,i) => s + i.totalWeight(), 0);
  }

  getFood() {
    const f = this.items.find(i => i.isFood());
    return f ? f.quantity : 0;
  }

  modFood(delta) {
    let f = this.items.find(i => i.isFood());
    if (delta > 0 && !f) {
      f = new Item({ id:'food', name:'干粮', quantity:0, weight:1, consumable:true, isfood:true, 'hp回复量':1 });
      this.items.push(f);
    }
    if (f) {
      f.quantity = Math.max(0, f.quantity + delta);
      if (f.quantity === 0) this.items = this.items.filter(i => !i.isFood());
    }
  }

  aliveAdventurers()   { return this.adventurers.filter(a => a.isAlive()); }
  activeAdventurers()  { return this.adventurers.filter(a => a.isActive()); }
  injuredAdventurers() { return this.adventurers.filter(a => a.isInjured()); }

  harosCorpseCook() {
    return this.adventurers.find(a => a.isAlive() && a.skill === '能把尸体做成干粮');
  }

  // ── Event pool ──────────────────────────────────────────────
  addToPool(eventId) {
    const ev = this.event_pool_static.find(e => e.id === eventId);
    if (ev && !this.event_pool.find(e => e.id === eventId)) {
      this.event_pool.push(ev);
    }
  }

  removeFromPool(eventId) {
    this.event_pool = this.event_pool.filter(e => e.id !== eventId);
  }

  drawEvent() {
    const eligible = this._eligibleEvents();
    if (!eligible.length) return null;
    const ev = eligible[Math.floor(Math.random() * eligible.length)];
    if (!ev.repeatable) this.removeFromPool(ev.id);
    return ev;
  }

  drawTwoEvents() {
    // Returns up to 2 distinct eligible events (does NOT remove from pool yet)
    const eligible = this._eligibleEvents();
    if (!eligible.length) return [];
    if (eligible.length === 1) return [eligible[0]];
    const idx1 = Math.floor(Math.random() * eligible.length);
    let idx2;
    do { idx2 = Math.floor(Math.random() * eligible.length); } while (idx2 === idx1);
    return [eligible[idx1], eligible[idx2]];
  }

  commitEvent(event) {
    // Call after player picks an event from drawTwoEvents
    this.event_history.push(event.id);
    if (!event.repeatable) this.removeFromPool(event.id);
    this.current_event = event;
    if (event.intro_effects) this.applyEffects(event.intro_effects);
  }

  _eligibleEvents() {
    return this.event_pool.filter(e => {
      if (e.conditions) {
        if (e.conditions.min_day && this.day < e.conditions.min_day) return false;
        if (e.conditions.require_events && !e.conditions.require_events.every(id => this.event_history.includes(id))) return false;
        if (e.conditions.exclude_events && e.conditions.exclude_events.some(id => this.event_history.includes(id))) return false;
        if (e.conditions.require_missing && !this.adventurers.some(a => a.status === STATUS.MISSING)) return false;
        if (e.conditions.require_dead && !this.adventurers.some(a => a.status === STATUS.DEAD)) return false;
      }
      return true;
    });
  }

  // ── Dice ────────────────────────────────────────────────────
  rollDice(n) {
    let sum = 0, rolls = [];
    for (let i = 0; i < n; i++) {
      const r = Math.random() < 0.5 ? 0 : 1;
      rolls.push(r);
      sum += r;
    }
    return { sum, rolls };
  }

  // ── Item use ─────────────────────────────────────────────────
  useItem(itemId) {
    const item = this.items.find(i => i.id === itemId);
    if (!item || !item.consumable) return { ok:false, msg:'无法使用' };
    if (this.phase === PHASE.CHECK) return { ok:false, msg:'检定中无法使用物品' };

    if (item.isFood()) {
      const targets = this.adventurers.filter(a => a.isAlive() && a.hp < a.hpMax());
      if (!targets.length) return { ok:false, msg:'所有人体力已满' };
      targets.sort((a,b) => (a.hp/a.hpMax()) - (b.hp/b.hpMax()));
      const target = targets[0];
      const hp_per = item.props['hp回复量'] || 1;
      const heal = Math.min(hp_per, target.hpMax() - target.hp);
      target.hp += heal;
      item.quantity--;
      if (item.quantity <= 0) this.items = this.items.filter(i => i.id !== itemId);
      this.log.push('【物资】' + target.name + ' 进食，恢复 ' + heal + ' 体力');
      return { ok:true, msg: target.name + ' 恢复 ' + heal + ' 体力' };
    }

    if (item.isDrug()) {
      // drug reduces injury by 1, only treats injury, not HP
      const injured = this.adventurers.filter(a => a.isAlive() && a.injury > 0);
      if (!injured.length) return { ok:false, msg:'无人需要治疗伤势' };

      // pick most injured
      injured.sort((a,b) => b.injury - a.injury);
      const target = injured[0];
      const oldInjury = target.injury;
      target.injury = Math.max(0, target.injury - 1);
      target.clampHp();
      this.log.push('【医疗】' + target.name + ' 伤势减轻（injury ' + oldInjury + ' → ' + target.injury + '）');
      item.quantity--;
      if (item.quantity <= 0) this.items = this.items.filter(i => i.id !== itemId);
      return { ok:true, msg: target.name + ' 得到治疗' };
    }

    return { ok:false, msg:'该物品无法手动使用' };
  }

  dropItem(itemId) {
    this.items = this.items.filter(i => i.id !== itemId);
    this.log.push('【物资】丢弃了一件物品');
  }

  feedAdventurer(adventurerId) {
    const a = this.adventurers.find(ad => ad.id === adventurerId);
    if (!a || !a.isAlive() || a.hp >= a.hpMax()) return { ok:false, msg:'该角色不需要进食' };
    const food = this.items.find(i => i.isFood());
    if (!food || food.quantity <= 0) return { ok:false, msg:'没有干粮' };
    const hp_per = food.props['hp回复量'] || 1;
    const heal = Math.min(hp_per, a.hpMax() - a.hp);
    a.hp += heal;
    food.quantity--;
    if (food.quantity <= 0) this.items = this.items.filter(i => !i.isFood());
    this.log.push('【物资】' + a.name + ' 进食，恢复 ' + heal + ' 体力');
    return { ok:true, msg: a.name + ' 恢复 ' + heal + ' 体力' };
  }

  healAdventurer(adventurerId) {
    const a = this.adventurers.find(ad => ad.id === adventurerId);
    if (!a || !a.isAlive()) return { ok:false, msg:'该角色无法治疗' };
    if (a.injury <= 0) return { ok:false, msg:'该角色没有伤势' };
    const drug = this.items.find(i => i.isDrug() && i.quantity > 0);
    if (!drug) return { ok:false, msg:'没有药草' };

    const oldInjury = a.injury;
    a.injury = Math.max(0, a.injury - 1);
    a.clampHp();
    this.log.push('【医疗】' + a.name + ' 伤势减轻（injury ' + oldInjury + ' → ' + a.injury + '）');
    drug.quantity--;
    if (drug.quantity <= 0) this.items = this.items.filter(i => i.id !== drug.id);
    return { ok:true, msg: a.name + ' 得到治疗' };
  }

  // ── End-of-day resolution (auto eat → auto drug → consume → wound rolls) ─
  endOfDay() {
    const log = [];

    // 1. Auto-eat: sort alive by (str+sta) descending, feed with weighted random selection
    const eaters = this.adventurers
      .filter(a => a.isAlive() && a.hp < a.hpMax())
      .sort((a, b) => {
        const scoreB = (b.attrs.str || 0) + b.sta;
        const scoreA = (a.attrs.str || 0) + a.sta;
        return scoreB - scoreA;
      });

    while (true) {
      const food = this.items.find(i => i.isFood());
      if (!food || food.quantity <= 0) break;
      const needEaters = eaters.filter(a => a.hp < a.hpMax());
      if (needEaters.length === 0) break;

      // Weighted random selection: higher priority (earlier in sorted list) has higher weight
      const weights = needEaters.map((a, i) => (needEaters.length - i) + (a.skill === '吃饭能力较强' ? 5 : 0) + (a.skill === '上帝的旨意' ? -1 : 0));
      const totalWeight = weights.reduce((sum, w) => sum + w, 0);
      let rand = Math.random() * totalWeight;
      let selected = null;
      for (let i = 0; i < needEaters.length; i++) {
        rand -= weights[i];
        if (rand <= 0) {
          selected = needEaters[i];
          break;
        }
      }

      const hp_per = food.props['hp回复量'] || 1;
      const heal = Math.min(hp_per, selected.hpMax() - selected.hp);
      if (heal > 0) {
        selected.hp += heal;
        food.quantity--;
        if (food.quantity <= 0) this.items = this.items.filter(i => !i.isFood());
        log.push({ type:'food', name: selected.name, heal });
        this.log.push('【进食】' + selected.name + ' 进食，恢复 ' + heal + ' 体力');
      }
    }

    // 2. Auto-drug: one herb per injured adventurer, most injured first
    const injuredForDrug = this.adventurers
      .filter(a => a.isAlive() && a.injury > 0)
      .sort((a, b) => b.injury - a.injury);

    for (const a of injuredForDrug) {
      const drug = this.items.find(i => i.isDrug() && i.quantity > 0);
      if (!drug) break;
      const oldInjury = a.injury;
      a.injury = Math.max(0, a.injury - 1);
      a.clampHp();
      drug.quantity--;
      if (drug.quantity <= 0) this.items = this.items.filter(i => i.id !== drug.id);
      log.push({ type:'drug', name: a.name, oldInjury, newInjury: a.injury });
      this.log.push('【医疗】' + a.name + ' 服药，伤势减轻（' + oldInjury + '→' + a.injury + '）');
    }

    // 3. Daily hp consumption — snapshot list first to avoid mid-loop mutation
    const aliveSnapshot = [...this.adventurers.filter(a => a.isAlive())];
    const starvationDeaths = [];
    for (const a of aliveSnapshot) {
      a.hp = Math.max(0, a.hp - 1);
      if (a.hp <= 0) {
        a.status = STATUS.DEAD;
        starvationDeaths.push(a);
        this.log.push('【力竭】' + a.name + ' 体力耗尽，倒在了路上');
      }
    }
    this.log.push('【消耗】每人消耗1体力');

    // Process starvation deaths AFTER all hp has been deducted,
    // so harosCorpseCook() can still find 陶范 if he survived
    for (const a of starvationDeaths) {
      this.handleDeath(a);
    }

    // 4. Wound rolls for remaining injured
    const woundResults = this.woundRolls();

    return { log, starvationDeaths, woundResults };
  }

  // ── Daily consume (kept for compatibility, delegates to endOfDay) ─────────
  dailyConsume() {
    // no-op: endOfDay() handles everything now
    return [];
  }

  // ── Wound rolls ──────────────────────────────────────────────
  woundRolls() {
    const injured = this.injuredAdventurers();
    const results = [];

    for (const a of injured) {
      // injury >= sta: already at 0 hp ceiling, die immediately
      if (a.injury >= a.sta) {
        a.status = STATUS.DEAD;
        results.push({ name:a.name, roll:'-', outcome:'dead', msg: a.name + ' 伤势过重，当日不治身亡' });
        this.log.push('【伤势】' + a.name + ' injury≥sta，不治身亡');
        this.handleDeath(a);
        continue;
      }

      const r = Math.floor(Math.random() * 6) + 1; // 1d6
      if (r >= 5) {
        a.injury = Math.max(0, a.injury - 1);
        a.clampHp();
        results.push({ name:a.name, roll:r, outcome:'recover', msg: a.name + ' 伤势好转（injury -1）' });
        this.log.push('【伤势】' + a.name + ' 掷 ' + r + '，好转');
      } else if (r <= 1) {
        a.injury += 1;
        a.clampHp();
        if (a.injury >= a.sta) {
          a.status = STATUS.DEAD;
          results.push({ name:a.name, roll:r, outcome:'dead', msg: a.name + ' 伤势恶化，伤重不治' });
          this.log.push('【伤势】' + a.name + ' 掷 ' + r + '，恶化致死');
          this.handleDeath(a);
        } else {
          results.push({ name:a.name, roll:r, outcome:'worsen', msg: a.name + ' 伤势恶化（injury +1）' });
          this.log.push('【伤势】' + a.name + ' 掷 ' + r + '，恶化');
        }
      } else {
        results.push({ name:a.name, roll:r, outcome:'stable', msg: a.name + ' 伤势维持' });
        this.log.push('【伤势】' + a.name + ' 掷 ' + r + '，维持');
      }
    }
    return results;
  }

  handleDeath(adventurer) {
    const lastWords = {
      0:'我还没看清……结局……',
      1:'腿……走不动了……',
      2:'路……还长……',
      3:'有人……看着我……',
      4:'我还能打……不甘心……',
      5:'这条路……走不完了……',
      6:'原来我也……会死……',
      7:'等等我……',
      8:'不行……还没……',
      9:'天命……原来如此……',
      10:'啾……',
      11:'不……',
      12:'还没……吃饱……',
      13:'这伤……不该要命的……',
      20:'继续走……别管我……',
      21:'右……右……',
      22:'左……',
      23:'不甘心……',
      24:'没想到……到不了……',
      25:'我……后悔了……',
      26:'早知如此……',
      27:'对不起……走不动了……',
      100:'我只是想活下去……',
    };
    const words = lastWords[adventurer.id] || '不甘心……';
    adventurer.last_words = words;
    this.log.push('【遗言】' + adventurer.name + '：「' + words + '」');

    const cook = this.harosCorpseCook();
    if (cook && cook.id !== adventurer.id) {
      const food_gain = Math.floor(adventurer.sta / 2);
      this.modFood(food_gain);
      this.log.push('【陶范】又多了' + food_gain + '份……浪费不得。');
    }

    if (this.adventurers.every(a => a.status === STATUS.DEAD || a.status === STATUS.MISSING)) {
      this.phase = PHASE.BAD_END;
    }
  }

  // ── 黹 skill ─────────────────────────────────────────────────
  zhiSkillTrigger() {
    const zhi = this.adventurers.find(a => a.isActive() && a.skill === '随机采摘1-2草药');
    if (!zhi) return null;
    if (Math.random() > 0.4) return null;
    const qty = Math.floor(Math.random() * 2) + 1;
    const existing = this.items.find(i => i.id === 'herb1');
    if (existing) {
      existing.quantity += qty;
    } else {
      this.items.push(new Item({ id:'herb1', name:'草药', quantity:qty, weight:1, consumable:true, isdrug:true, 'hp回复量':1 }));
    }
    const speeches = [
      '草的气味告诉我，它在这里等了很久。',
      '土里还有更多，但我们带不走。',
      '夜里有露水的地方，草药长得最好。',
      '它认识我。',
    ];
    const speech = speeches[Math.floor(Math.random() * speeches.length)];
    this.log.push('【黹】' + speech);
    this.log.push('【技能】黹采集到 ' + qty + ' 份草药');
    return { qty, speech };
  }

  // ── Check resolution ─────────────────────────────────────────
  resolveCheck(check) {
    const stat = check.stat;
    const player_val = this.getPartyStat(stat);
    const enemy_val  = check.difficulty || 0;
    const player_roll = this.rollDice(player_val);
    const enemy_roll  = this.rollDice(enemy_val);
    const success = player_roll.sum >= enemy_roll.sum;
    return { stat, player_val, enemy_val, player_roll, enemy_roll, success };
  }

  // ── Apply effects ────────────────────────────────────────────
  applyEffects(effects) {
    const messages = [];
    if (!effects) return messages;

    for (const eff of effects) {
      if (eff.type === 'party_stat') {
        if (eff.stat === 'food') {
          this.modFood(eff.delta);
          messages.push('干粮 ' + (eff.delta > 0 ? '+' : '') + eff.delta);
        }

      } else if (eff.type === 'advance_day') {
        this.day += eff.delta || 1;
        messages.push('抄近道，天数提前 ' + (eff.delta || 1) + ' 日');
        this.log.push('【捷径】天数提前 ' + (eff.delta || 1) + ' 日');

      } else if (eff.type === 'char_injury') {
        // {type:'char_injury', target:'random_active'|'all_active', delta:1, count:1}
        const pool = eff.target === 'all_active'
          ? this.activeAdventurers()
          : this._weightedActivePool(eff.count || 1);
        for (const a of pool) {
          const old = a.injury;
          a.injury = Math.max(0, a.injury + eff.delta);
          a.clampHp();
          if (eff.delta > 0) {
            messages.push(a.name + ' 受伤（injury +' + eff.delta + '）');
            this.log.push('【后果】' + a.name + ' injury ' + old + ' → ' + a.injury);
            if (a.injury >= a.sta) {
              a.status = STATUS.DEAD;
              this.log.push('【后果】' + a.name + ' 伤势超过承受极限，当场死亡');
              this.handleDeath(a);
            }
          } else {
            messages.push(a.name + ' 伤势减轻');
          }
        }

      } else if (eff.type === 'char_status') {
        // only MISSING/DEAD remain as status effects
        const pool = eff.target === 'missing'
          ? this.adventurers.filter(a => a.status === STATUS.MISSING)
          : this._weightedActivePool(eff.count || 1);
        for (const a of pool) {
          a.status = eff.status;
          const statusName = eff.status === STATUS.MISSING ? '失踪' : '死亡';
          messages.push(a.name + ' ' + statusName);
          this.log.push('【后果】' + a.name + ' ' + statusName);
          if (eff.status === STATUS.DEAD) this.handleDeath(a);
          if (eff.status === STATUS.MISSING) {
            this.addToPool('find_missing');
            this.addToPool('found_dead');
          }
        }

      } else if (eff.type === 'char_hp') {
        const pool = eff.target === 'all_alive'
          ? this.aliveAdventurers()
          : [this.activeAdventurers().sort((a,b) => (a.hp/a.hpMax()) - (b.hp/b.hpMax()))[0]].filter(Boolean);
        for (const a of pool) {
          a.hp = Math.max(0, Math.min(a.hpMax(), a.hp + eff.delta));
          messages.push(a.name + ' HP' + (eff.delta > 0 ? '+' : '') + eff.delta);
          if (a.hp <= 0) {
            a.status = STATUS.DEAD;
            this.log.push('【后果】' + a.name + ' 体力归零，死亡');
            this.handleDeath(a);
          }
        }

      } else if (eff.type === 'add_event') {
        this.addToPool(eff.event_id);
      } else if (eff.type === 'remove_event') {
        this.removeFromPool(eff.event_id);
      } else if (eff.type === 'bad_end') {
        this.phase = PHASE.BAD_END;
        messages.push(eff.msg || '全队覆灭');
      } else if (eff.type === 'add_item') {
        const existing = this.items.find(i => i.id === eff.item.id);
        if (existing) existing.quantity += eff.item.quantity || 1;
        else this.items.push(new Item(eff.item));
        messages.push('获得 ' + eff.item.name + ' ×' + (eff.item.quantity || 1));
      } else if (eff.type === 'recruit') {
        this.pending_recruit = eff.adventurer;
        messages.push('遇到新角色 ' + eff.adventurer.name);
      }
    }
    return messages;
  }

  _weightedActivePool(count) {
    const pool = this.activeAdventurers();
    if (!pool.length) return [];
    const weighted = [];
    for (const a of pool) {
      const w = Math.max(1, Math.round((1 - a.hp / Math.max(1, a.hpMax())) * 10) + 1);
      for (let i = 0; i < w; i++) weighted.push(a);
    }
    const chosen = new Set();
    const result = [];
    for (let i = 0; i < count && weighted.length; i++) {
      let attempts = 0;
      while (attempts < 20) {
        const idx = Math.floor(Math.random() * weighted.length);
        const target = weighted[idx];
        if (!chosen.has(target.id)) { chosen.add(target.id); result.push(target); break; }
        attempts++;
      }
    }
    return result;
  }

  confirmRecruit(yes) {
    if (!this.pending_recruit) return;
    if (yes) {
      this.adventurers.push(new Adventurer(this.pending_recruit));
      this.log.push('【入队】' + this.pending_recruit.name + ' 加入队伍');
    }
    this.pending_recruit = null;
  }

  confirmLoot(selectedIds) {
    if (!this.pending_loot) return;
    let capacity = this.getWeightCapacity() - this.getCurrentWeight();
    for (const id of selectedIds) {
      const item = this.pending_loot.find(i => i.id === id);
      if (!item) continue;
      if (item.weight * item.quantity > capacity) {
        const can = Math.floor(capacity / item.weight);
        if (can > 0) item.quantity = can;
        else continue;
      }
      const existing = this.items.find(i => i.id === item.id);
      if (existing) existing.quantity += item.quantity;
      else this.items.push(new Item(item));
      capacity -= item.weight * item.quantity;
      this.log.push('【物资】拾取 ' + item.name + ' ×' + item.quantity);
    }
    this.pending_loot = null;
  }
}

// ============================================================
// CHARACTER SPEECHES
// ============================================================

const EVENING_SPEECHES = {
  0:  ['今日的卦象……还不明朗。', '我感到某种东西在靠近。', '星象说明天会更难。'],
  1:  ['腿还能走，还没事。', '今天的水不够喝。', '肚子有点空。'],
  2:  ['路还长，省点力气。', '今天没死，算运气好。', '不知道还要走几天。'],
  3:  ['有人看着我……', '我不喜欢这里的气味。', '再走一天吧。'],
  4:  ['再强的敌人也拦不住我。', '受伤了？没关系，能打就行。', '前面有什么，打过去就是了。'],
  5:  ['要统筹好资源……', '今日损耗可控。', '继续维持现在的节奏。'],
  6:  ['我不会死在这里。', '……', '有点冷。'],
  7:  ['……好累。', '能不能休息一下。', '我跟上了。'],
  8:  ['这活不好干。', '凑合着过吧。', '再熬一天。'],
  9:  ['草木自有灵性，顺它就好。', '今晚月色不对。', '有人的气数在变。'],
  10: ['啾。', '……', '（蜷缩在角落里）'],
  11: ['走，继续走。', '别问我，我也不知道。', '……就这样吧。'],
  12: ['今天的料不够新鲜，可惜了。', '腌制需要盐，盐不够用。', '下次遇到……说不定能做得更好。'],
  13: ['凑合着走吧。', '这伤不妨事。', '……先不说话了。'],
  20: ['按计划推进。', '减少不必要的消耗。', '注意两翼。'],
  21: ['右，还在。', '这条路……认识。', '坚持。'],
  22: ['左还好。', '……', '走。'],
  23: ['比预想的难。', '不退。', '再扛一天。'],
  24: ['快到了吧？', '……应该快了。', '腿软了。'],
  25: ['说错了一句话，很抱歉。', '我没有意见。', '……听安排。'],
  26: ['伤还在疼。', '不知道能不能好。', '撑着呢。'],
  27: ['动起来还行，停下来就难受。', '别让我落队。', '……继续。'],
  100:['我有用的……', '我能扛东西。', '别丢下我。'],
};

function getEveningSpeech(adventurer) {
  const lines = EVENING_SPEECHES[adventurer.id];
  if (!lines) return null;
  return lines[Math.floor(Math.random() * lines.length)];
}

// ============================================================
// REACTION SPEECHES
// ============================================================

const REACTION_SPEECHES = {
  0:  ['这卦象……果然如此。', '天意难测，但我们做到了。', '星辰指引，我们走对了路。'],
  1:  ['眼睛看到了，但心还没明白。', '这事……有点意思。', '下次小心点。'],
  2:  ['路还长，经验多了。', '这次运气好。', '记住了。'],
  3:  ['我感觉到了什么……', '这味道不对，但过去了。', '下次别再这样。'],
  4:  ['打得不错！', '敌人太弱了。', '下次再来。'],
  5:  ['资源消耗可控。', '计划有变，但还好。', '统筹得当。'],
  6:  ['我还活着。', '……', '这次差点。'],
  7:  ['累了，但坚持住了。', '差点跟不上。', '休息一下。'],
  8:  ['这活真他妈难干。', '凑合过去了。', '下次别遇上了。'],
  9:  ['草药的气息告诉我，危机过去了。', '自然有它的道理。', '我们学到了。'],
  10: ['啾……', '……', '（蜷缩着）'],
  11: ['就这样吧。', '没什么好说的。', '继续走。'],
  12: ['这肉……可惜了。', '下次小心处理。', '浪费不得。'],
  13: ['差点就完了。', '这伤口疼。', '记住了教训。'],
  20: ['战术调整成功。', '损失在可接受范围内。', '继续执行。'],
  21: ['右边安全了。', '这次走对了。', '坚持路线。'],
  22: ['左边没事。', '……', '继续前进。'],
  23: ['险情解除。', '不退缩是对的。', '下次更谨慎。'],
  24: ['终于过去了。', '……快到了吧。', '腿还行。'],
  25: ['我错了……', '下次不说错话。', '抱歉。'],
  26: ['伤口还在，但活下来了。', '疼，但值得。', '撑过去了。'],
  27: ['动起来就好。', '差点倒下。', '继续。'],
  100:['我帮上忙了……', '我扛住了。', '别抛下我。'],
};

function getReactionSpeech(adventurer) {
  const lines = REACTION_SPEECHES[adventurer.id];
  if (!lines) return null;
  return lines[Math.floor(Math.random() * lines.length)];
}

// ============================================================
// DEMO DATA
// ============================================================

const DEMO_ADVENTURERS = [
  { id:0,  name:'贞',  sta:3, skill:'上帝的旨意' },
  { id:1,  name:'目',  sta:3, int:3 },
  { id:2,  name:'朝',  sta:3 },
  { id:3,  name:'丽',  sta:3, skill:'吃饭能力较强' },
  { id:4,  name:'钺',  sta:4, str:3 },
  { id:5,  name:'雍',  sta:4, str:2, int:2, skill:'自我管理能力' },
  { id:6,  name:'幽',  sta:3, str:3 },
  { id:7,  name:'七',  sta:3 },
  { id:8,  name:'冶',  sta:4, str:1 },
  { id:9,  name:'黹',  sta:3, int:2, skill:'随机采摘1-2草药' },
  { id:10, name:'玄鸟',sta:2 },
  { id:11, name:'旬',  sta:3 },
  { id:12, name:'陶范',sta:4, str:1, skill:'能把尸体做成干粮' },
  { id:13, name:'错',  sta:3, str:1 },
  { id:20, name:'执',  sta:4, str:2, int:1 },
  { id:21, name:'左',  sta:4, str:2 },
  { id:22, name:'右',  sta:4, str:2 },
  { id:23, name:'丑',  sta:3, int:1 },
  { id:24, name:'登',  sta:3, int:1 },
  { id:25, name:'舌',  sta:3, int:1 },
  { id:26, name:'阮',  sta:3, injury:1 },
  { id:27, name:'未',  sta:3, str:3, injury:1 },
];

const DEMO_ITEMS = [
  { id:'food',  name:'干粮', quantity:14, weight:1, consumable:true,  isfood:true,  'hp回复量':1 },
  { id:'herb1', name:'草药', quantity:4,  weight:1, consumable:true,  isdrug:true,  'hp回复量':1 },
  { id:'ge',    name:'戈',   quantity:2,  weight:3, consumable:false, str:2 },
];

const DEMO_EVENTS = [
  {
    id:'ambush', name:'伏击', repeatable:true,
    hexagram:'师', hint:'军队来袭，需谨慎应对', terrain:'密林',
    intro:'林中突然杀出一队盗匪，为首者手持铜钺，眼神凶狠。队伍被前后夹击，无处可退。',
    checks:[{
      label:'武力对决', stat:'str', difficulty:16,
      success_text:'血战之后，盗匪溃散。地上横七竖八躺着几具尸体。',
      failure_text:'抵挡不住，队伍被迫分散突围，狼狈撤退。',
      success_effects:[
        { type:'add_item', item:{ id:'loot_bronze', name:'青铜短刀', quantity:1, weight:2, consumable:false, str:1 } },
        { type:'party_stat', stat:'food', delta:+6 },
      ],
      failure_effects:[
        { type:'char_injury', target:'random_active', delta:1, count:2 },
        { type:'party_stat', stat:'food', delta:-3 },
      ],
    }],
    conditions:{},
  },
  {
    id:'beast', name:'猛兽出没', repeatable:true,
    hexagram:'噬嗑', hint:'野兽噬咬，需以力制服', terrain:'山野',
    intro:'夜营时，营地边缘传来沉重的喘息声。篝火映出一双黄色的眼睛——是饥饿的豺狼，不止一头。',
    checks:[{
      label:'驱兽（武）', stat:'str', difficulty:14,
      success_text:'举火呐喊，兽群被驱散，只留下一地爪印，和几只受伤的野兽',
      failure_text:'豺狼冲入营地，撕咬人员，抢走了食物。',
      success_effects:[
        { type:'party_stat', stat:'food', delta:4 },
      ],
      failure_effects:[
        { type:'char_injury', target:'random_active', delta:1, count:1 },
        { type:'party_stat', stat:'food', delta:-4 },
      ],
    }],
    conditions:{},
  },
  {
    id:'hunt', name:'狩猎', repeatable:true,
    hexagram:'比', hint:'比邻相亲，狩猎可得', terrain:'丛林',
    intro:'发现了野猪的踪迹，蹄印新鲜，数量不少。若能猎获，可解燃眉之急。',
    checks:[
      {
        label:'追踪猎物（智）', stat:'int', difficulty:10,
        success_text:'悄悄接近，猎物尚未察觉。',
        failure_text:'踪迹断了，猎物早已惊走。',
        success_effects:[], failure_effects:[], fail_ends_event:true,
      },
      {
        label:'制服野猪（武）', stat:'str', difficulty:14,
        success_text:'两头野猪被猎获，众人大快朵颐。',
        failure_text:'野猪受伤逃脱，追击途中有人被獠牙划伤。',
        success_effects:[{ type:'party_stat', stat:'food', delta:6 }],
        failure_effects:[{ type:'char_injury', target:'random_active', delta:1, count:1 }],
      },
    ],
    conditions:{},
  },
  {
    id:'forage', name:'采集野果', repeatable:true,
    hexagram:'豫', hint:'豫乐有喜，采集需谨慎', terrain:'山坡',
    intro:'路旁山坡上长着大片不知名的浆果，颜色鲜艳，不知是否可食。',
    checks:[{
      label:'辨别毒性（智）', stat:'int', difficulty:9,
      success_text:'认出了可食的品种，采摘了不少。',
      failure_text:'分辨不清，有人忍不住尝了颜色好看的……',
      success_effects:[{ type:'party_stat', stat:'food', delta:3 }],
      failure_effects:[
        { type:'party_stat', stat:'food', delta:1 },
        { type:'char_hp', target:'lowest_hp', delta:-2 },
      ],
    }],
    conditions:{},
  },
  {
    id:'mudslide', name:'山体滑坡', repeatable:false,
    hexagram:'剥', hint:'剥落崩坏，山崩地裂', terrain:'山道',
    intro:'连日阴雨，山道突然传来轰鸣，泥石俱下，前路被堵死。',
    checks:[{
      label:'强行开路（武）', stat:'str', difficulty:18,
      success_text:'众人合力，搬开巨石，勉强打通了一条缝隙。',
      failure_text:'力气耗尽，只能绕道，多走了半天，粮食消耗倍增。',
      success_effects:[],
      failure_effects:[
        { type:'party_stat', stat:'food', delta:-6 },
        { type:'char_hp', target:'random_active', delta:-1, count:5 },
      ],
    }],
    conditions:{},
  },
  {
    id:'plague', name:'疫病蔓延', repeatable:false,
    hexagram:'复', hint:'复归本源，疫病复发', terrain:'营地',
    intro:'夜里有人突发高热，口吐黑水，营地中弥漫着腐败的气息。到早晨，已有几人神色不对。',
    checks:[{
      label:'隔离处置（智）', stat:'int', difficulty:12,
      success_text:'迅速隔离病患，烧掉污染的器具，疫情得到控制。',
      failure_text:'处置迟缓，疫病在队伍中迅速扩散，人人自危。',
      success_effects:[],
      failure_effects:[
        { type:'char_hp', target:'random_active', delta:-2, count:5 },
        { type:'char_injury', target:'random_active', delta:1, count:2 },
      ],
    }],
    conditions:{ min_day:2 },
  },
  {
    id:'lost', name:'迷路', repeatable:true,
    hexagram:'困', hint:'困于迷途，需智解困', terrain:'雾林',
    intro:'雾气弥漫，向导也辨不清方向，队伍在山间转了大半天，原地打转。',
    checks:[{
      label:'辨别方向（智）', stat:'int', difficulty:11,
      success_text:'终于找到了参照物，重新确认方向，虽然耗费时间，但没有更大损失。',
      failure_text:'越走越深，有人在混乱中与大队失散。',
      success_effects:[{ type:'char_hp', target:'random_active', delta:-1, count:5 }],
      failure_effects:[
        { type:'char_hp', target:'random_active', delta:-1, count:5 },
        { type:'char_status', target:'random_active', status:STATUS.MISSING, count:1 },
      ],
    }],
    conditions:{},
  },
  {
    id:'river_crossing', name:'渡河', repeatable:false,
    hexagram:'解', hint:'解开困境，渡河成功', terrain:'河边',
    intro:'前方一条湍急的河流拦住去路。水面宽阔，水色浑浊，看不清深浅，河边没有舟筏。',
    checks:[{
      label:'强渡（武）', stat:'str', difficulty:17,
      success_text:'众人手拉手，在激流中站稳脚跟，全员艰难渡过。',
      failure_text:'水流太急，有人被冲走，物资也损失大半。',
      success_effects:[],
      failure_effects:[
        { type:'char_status', target:'random_active', status:STATUS.MISSING, count:1 },
        { type:'party_stat', stat:'food', delta:-4 },
      ],
    }],
    conditions:{},
  },
  {
    id:'night_raid', name:'夜袭营地', repeatable:true,
    hexagram:'坎', hint:'坎险在前，夜袭危机', terrain:'营地',
    intro:'夜深人静，哨兵突然大喊——黑暗中不知多少人影正在逼近，是有备而来的袭击。',
    checks:[{
      label:'抵御夜袭（武）', stat:'str', difficulty:18,
      success_text:'在混乱中组织起防线，击退了来袭之敌，天明时才看清地上的血迹有多深。',
      failure_text:'营地被冲散，伤亡惨重，物资被劫走大半。',
      success_effects:[],
      failure_effects:[
        { type:'char_injury', target:'random_active', delta:1, count:2 },
        { type:'party_stat', stat:'food', delta:-5 },
      ],
    }],
    conditions:{ min_day:3 },
  },
  {
    id:'find_missing', name:'搜寻失踪者', repeatable:false,
    hexagram:'离', hint:'离散复聚，寻找失踪', terrain:'密林',
    intro:'有人提议停下来找找失踪的同伴，说不定还没走远。',
    checks:[{
      label:'搜寻（智）', stat:'int', difficulty:9,
      success_text:'在密林深处找到了失踪者，形容狼狈，但还活着。',
      failure_text:'搜遍附近，毫无踪影，也许已经凶多吉少。',
      success_effects:[{ type:'add_event', event_id:'rescue_success' }],
      failure_effects:[],
    }],
    conditions:{ require_missing:true },
  },
  {
    id:'found_dead', name:'发现遗体', repeatable:false,
    hexagram:'震', hint:'震动惊悚，发现尸体', terrain:'路边',
    intro:'有人在路边发现了一具尸体，认出是失踪的同伴。',
    checks:[],
    intro_effects:[{ type:'char_status', target:'missing', status:STATUS.DEAD, count:1 }],
    conditions:{ require_missing:true },
  },
  {
    id:'merchant', name:'行商', repeatable:false,
    hexagram:'巽', hint:'巽顺相随，商人同行', terrain:'山道',
    intro:'山道上遇到一支落魄的商队，车轮陷在泥里，他们愿意以物资换取帮助。',
    checks:[{
      label:'帮助商队脱困（武）', stat:'str', difficulty:12,
      success_text:'合力将车推出泥坑，商人千恩万谢，拿出了不少物资相赠。',
      failure_text:'人手不够，推不动，商人只给了些零散物资表示谢意。',
      success_effects:[], failure_effects:[],
    }],
    loot:[
      { id:'herb_merchant', name:'草药', quantity:5, weight:1, consumable:true, isdrug:true, 'hp回复量':1 },
      { id:'food_merchant', name:'干粮', quantity:8, weight:1, consumable:true, isfood:true, 'hp回复量':1 },
      { id:'shield', name:'干（盾）', quantity:1, weight:4, consumable:false },
    ],
    conditions:{},
  },
  {
    id:'abandoned_camp', name:'废弃营地', repeatable:false,
    hexagram:'艮', hint:'艮止不动，废弃营地', terrain:'营地',
    intro:'发现了一处废弃的营地，灰烬还温，有人匆忙离去的痕迹，遗留了一些物资。',
    checks:[],
    loot:[
      { id:'camp_food',  name:'干粮', quantity:4, weight:1, consumable:true, isfood:true, 'hp回复量':1 },
      { id:'camp_herb',  name:'草药', quantity:2, weight:1, consumable:true, isdrug:true, 'hp回复量':1 },
      { id:'camp_knife', name:'铜刀', quantity:1, weight:2, consumable:false, str:1 },
    ],
    conditions:{},
  },
  {
    id:'slave', name:'遗民', repeatable:false,
    hexagram:'兑', hint:'兑悦相遇，遗民相助', terrain:'路旁',
    intro:'路旁蜷缩着一个年轻人，衣衫褴褛，但身形结实。他抬起头，眼神里有一丝希望。',
    checks:[],
    recruit:{ id:100, name:'奴隶', sta:2, str:1 },
    conditions:{},
  },
  {
  id:'cliff_path', name:'险道', repeatable:true,
  hexagram:'艮', hint:'艮止险路，慎行可过', terrain:'山道',
  intro:'前方山道狭窄，一侧是峭壁，一侧是深谷。脚下碎石滚落，稍有不慎便是万丈深渊。',
  checks:[{
    label:'稳步通过（武）', stat:'str', difficulty:13,
    success_text:'众人贴壁缓行，互相搀扶，终于通过了险道。',
    failure_text:'有人脚下一滑，连带着旁边的人跌倒，虽没有坠崖，但摔伤了几人。',
    success_effects:[],
    failure_effects:[
      { type:'char_injury', target:'random_active', delta:1, count:1 },
      { type:'char_hp', target:'all_alive', delta:-1 },
    ],
  }],
  conditions:{},
},
{
  id:'flash_flood', name:'山洪', repeatable:false,
  hexagram:'坎', hint:'坎水暴至，险象环生', terrain:'山谷',
  intro:'上游传来轰鸣，还没反应过来，泥黄的洪水已经漫过小腿。谷地里无处可逃，只能往高处跑。',
  checks:[
    {
      label:'抢先登高（武）', stat:'str', difficulty:15,
      success_text:'众人拼力奔跑，全员爬上了高坡，俯看洪水卷走了低处的东西。',
      failure_text:'来不及，洪水漫上来，有人被冲倒，物资大量流失。',
      success_effects:[{ type:'party_stat', stat:'food', delta:-2 }],
      failure_effects:[
        { type:'party_stat', stat:'food', delta:-6 },
        { type:'char_hp', target:'all_alive', delta:-2 },
      ],
      fail_ends_event:true,
    },
    {
      label:'清点物资（智）', stat:'int', difficulty:9,
      success_text:'在乱中仍有人记挂着物资，抢回了一些。',
      failure_text:'慌乱之中，什么也没来得及救。',
      success_effects:[{ type:'party_stat', stat:'food', delta:3 }],
      failure_effects:[],
    },
  ],
  conditions:{},
},
{
  id:'wildfire', name:'山火', repeatable:false,
  hexagram:'离', hint:'离火炎上，焚林阻路', terrain:'林地',
  intro:'前方树冠突然腾起烟柱，风一吹，火舌迅速蔓延。林子里浓烟滚滚，方向已经辨不清了。',
  checks:[
    {
      label:'辨风向逃离（智）', stat:'int', difficulty:11,
      success_text:'有人判出了风向，队伍绕过火头，从侧翼突出重围。',
      failure_text:'判断失误，跑进了烟最浓的地方，众人呛咳不止，险些晕倒。',
      success_effects:[],
      failure_effects:[
        { type:'char_hp', target:'random_active', delta:-2, count:5 },
      ],
      fail_ends_event:true,
    },
    {
      label:'冲出火线（武）', stat:'str', difficulty:14,
      success_text:'众人咬牙冲过火线，虽然烧焦了衣物，人总算出来了。',
      failure_text:'冲势不足，被烧伤了几人。',
      success_effects:[],
      failure_effects:[
        { type:'char_injury', target:'random_active', delta:1, count:2 },
      ],
    },
  ],
  conditions:{},
},
{
  id:'quarrel', name:'内讧', repeatable:true,
  hexagram:'睽', hint:'睽违离散，内生矛盾', terrain:'营地',
  intro:'连日疲行，积压的怒火终于爆发。两人在营地里起了冲突，眼看就要动手，其余人面面相觑。',
  checks:[{
    label:'居中调停（智）', stat:'int', difficulty:10,
    success_text:'说开了，各退一步。夜里气氛还是沉，但没有人再说话了。',
    failure_text:'没人压得住，打了起来，两人都挂了彩，士气跌到谷底。',
    success_effects:[],
    failure_effects:[
      { type:'char_hp', target:'random_active', delta:-2 },
      { type:'char_hp', target:'random_active', delta:-2 },
    ],
  }],
  conditions:{},
},
{
  id:'desertion', name:'有人想离队', repeatable:false,
  hexagram:'遁', hint:'遁逃之心，难以强留', terrain:'营地',
  intro:'清晨点名，有人没有出现。找到时，他正收拾行囊，说不想再走了，想回头。',
  checks:[{
    label:'劝说留下（智）', stat:'int', difficulty:11,
    success_text:'说了很久。他沉默了一会儿，最终还是把包放下了。',
    failure_text:'没能留住。他一个人往来路走去，没有回头。',
    success_effects:[],
    failure_effects:[
      { type:'char_status', target:'random_active', status:STATUS.MISSING, count:1 },
    ],
  }],
  conditions:{ min_day:3 },
},
{
  id:'ill_omen', name:'不祥之兆', repeatable:true,
  hexagram:'蛊', hint:'蛊惑人心，谣言乱队', terrain:'营地',
  intro:'有人夜里听见了怪声，说是前方有厉鬼拦路。消息传开，队伍里开始有人不肯上路。',
  checks:[
    {
      label:'查明原委（智）', stat:'int', difficulty:9,
      success_text:'仔细勘察，是林间野物的叫声。虽然如此，仍有人半信半疑。',
      failure_text:'查不清楚，谣言越传越烈，人心惶惶。',
      success_effects:[],
      failure_effects:[
        { type:'char_hp', target:'random_active', delta:-1, count:5 },
      ],
      fail_ends_event:true,
    },
    {
      label:'激励士气（武）', stat:'str', difficulty:10,
      success_text:'有人当众斥退怯懦，队伍重新振作，继续上路。',
      failure_text:'话说得太狠，反而激起了反弹，当天走得很慢。',
      success_effects:[],
      failure_effects:[
        { type:'char_hp', target:'random_active', delta:-1, count:5 },
      ],
    },
  ],
  conditions:{ min_day:2 },
},
{
  id:'find_spring', name:'发现山泉', repeatable:true,
  hexagram:'井', hint:'井养不穷，甘泉相助', terrain:'山地',
  intro:'有人发现了一处山泉，水色清亮，苔藓碧绿。是这几日难得见到的清洁水源。',
  checks:[{
    label:'检视水质（智）', stat:'int', difficulty:7,
    success_text:'确认水质无虞，众人饱饮，精神为之一振。',
    failure_text:'没能判断清楚，喝了之后有几人腹痛。',
    success_effects:[{ type:'char_hp', target:'all_alive', delta:1 }],
    failure_effects:[{ type:'char_hp', target:'random_active', delta:-2 }],
  }],
  conditions:{},
},
{
  id:'ruins', name:'殷人遗址', repeatable:false,
  hexagram:'观', hint:'观察遗迹，往事如烟', terrain:'废墟',
  intro:'荒草丛中露出几根断柱，刻着已经模糊的纹样。这里曾经住过人，是很久以前的事了。',
  checks:[
    {
      label:'仔细搜寻（智）', stat:'int', difficulty:10,
      success_text:'在废墟角落翻出了一个陶罐，里面还封存着干货。',
      failure_text:'翻了半天，只有破陶片和腐朽的木料，什么也没有。',
      success_effects:[{ type:'party_stat', stat:'food', delta:4 }],
      failure_effects:[],
      fail_ends_event:true,
    },
    {
      label:'辨认铭文（智）', stat:'int', difficulty:12,
      success_text:'有人认出了部分字迹——是路引，指向前方还有一条隐路，可以少走两日。',
      failure_text:'字迹太模糊，认不出来。',
      success_effects:[{ type:'party_stat', stat:'food', delta:-4 }],  // 省了两日消耗折算
      failure_effects:[],
    },
  ],
  conditions:{},
},
{
  id:'refugee_group', name:'流民', repeatable:false,
  hexagram:'旅', hint:'旅途相逢，同是流离', terrain:'山道',
  intro:'前方遇到一群流民，老弱居多，面黄肌瘦。他们盯着队伍的干粮袋，眼神里有乞求，也有警惕。',
  checks:[{
    label:'施以援手（智）', stat:'int', difficulty:8,
    success_text:'分出了一些干粮。流民中有人感激，主动带路，少走了不少弯路。',
    failure_text:'没有余粮可分，双方对峙了一会儿，最终流民散去，留下一地沉默。',
    success_effects:[
      { type:'party_stat', stat:'food', delta:-3 },
      { type:'advance_day', delta:1 },
    ],
    failure_effects:[],
  }],
  conditions:{},
},
{
  id:'abandoned_child', name:'弃婴', repeatable:false,
  hexagram:'蒙', hint:'蒙稚初生，何去何从', terrain:'路旁',
  intro:'路旁草丛里传来微弱的哭声。是个孩子，裹着破布，脸上还有泪痕，不知被遗弃多久了。',
  checks:[{
    label:'决断去留（智）', stat:'int', difficulty:9,
    success_text:'有人主动抱起了孩子，说走到下一个有人烟的地方再做打算。队伍的脚步慢了一些，但没有人反对。',
    failure_text:'众人争执太久，最终不得不放弃。走出很远，哭声还在身后。有人一整天没有说话。',
    success_effects:[
      { type:'party_stat', stat:'food', delta:-1 },
    ],
    failure_effects:[
      { type:'char_hp', target:'all_alive', delta:-1 },
    ],
  }],
  conditions:{},
},
{
  id:'strange_dream', name:'异梦', repeatable:true,
  hexagram:'颐', hint:'颐养正道，梦兆吉凶', terrain:'营地',
  intro:'数人同夜做了相近的梦：一条大河，对岸站着认识的人，但怎么也渡不过去。醒来之后，没有人先开口。',
  checks:[{
    label:'解读梦兆（智）', stat:'int', difficulty:8,
    success_text:'有人说，梦见渡不过去，是说前路有阻，但终能过去。众人沉默，也算接受了这个说法。',
    failure_text:'无人能解，有人越想越不安，一整天心神不宁。',
    success_effects:[],
    failure_effects:[{ type:'char_hp', target:'all_alive', delta:-1 }],
  }],
  conditions:{},
},
{
  id:'oracle_bone', name:'卜骨', repeatable:false,
  hexagram:'大有', hint:'大有所得，问卜于天', terrain:'营地',
  intro:'贞取出一片兽骨，以火灼之。裂纹蜿蜒，有几条走向不好看。',
  checks:[{
    label:'据兆备险（智）', stat:'int', difficulty:10,
    success_text:'众人依兆行事，提前做了防备，当天遇到的麻烦比预想中少了许多。',
    failure_text:'有人不信，照常行事，到了傍晚才明白那兆是什么意思。',
    success_effects:[],
    failure_effects:[
      { type:'char_hp', target:'all_alive', delta:-1 },
      { type:'party_stat', stat:'food', delta:-2 },
    ],
  }],
  conditions:{},
},{
  id:'river_fish', name:'捕鱼', repeatable:true,
  hexagram:'需', hint:'需待时机，守水得鱼', terrain:'河边',
  intro:'路过一条浅河，水清见底，有鱼影游动。若能捕到，是难得的荤腥。',
  checks:[
    {
      label:'编网设陷（智）', stat:'int', difficulty:9,
      success_text:'用衣料编了个简陋的网，设在水流收窄处。',
      failure_text:'网没编好，鱼群受惊四散。',
      success_effects:[], failure_effects:[], fail_ends_event:true,
    },
    {
      label:'收网起鱼（武）', stat:'str', difficulty:11,
      success_text:'一网下去，捞起了不少。众人就地烤鱼，难得吃了顿热食。',
      failure_text:'鱼太滑，大半漏网，只捞到几条小的。',
      success_effects:[{ type:'party_stat', stat:'food', delta:5 }],
      failure_effects:[{ type:'party_stat', stat:'food', delta:1 }],
    },
  ],
  conditions:{},
},
{
  id:'trapped_beast', name:'陷阱', repeatable:true,
  hexagram:'屯', hint:'屯积待时，设陷猎兽', terrain:'林地',
  intro:'有人发现了自己昨日设下的陷阱——里面压着一头小鹿，还没有断气。',
  checks:[
    {
      label:'制服猎物（武）', stat:'str', difficulty:10,
      success_text:'干净利落地解决了，没让它受太多苦。',
      failure_text:'小鹿挣脱了，带着伤跑进林子里，什么也没得到。',
      success_effects:[], failure_effects:[], fail_ends_event:true,
    },
    {
      label:'处理皮肉（智）', stat:'int', difficulty:8,
      success_text:'熟练地剥皮分肉，一点没有浪费。兽皮也留着，或许有用。',
      failure_text:'手法生疏，糟蹋了不少好肉。',
      success_effects:[
        { type:'party_stat', stat:'food', delta:5 },
        { type:'add_item', item:{ id:'hide', name:'兽皮', quantity:1, weight:2, consumable:false, sta:1 } },
      ],
      failure_effects:[{ type:'party_stat', stat:'food', delta:2 }],
    },
  ],
  conditions:{},
},
{
  id:'hostile_tribe', name:'异族斥候', repeatable:false,
  hexagram:'师', hint:'师出有名，御敌于外', terrain:'山道',
  intro:'山道转角，迎面撞上几个装束陌生的斥候。双方都愣了一下，然后他们摘下了弓。',
  checks:[
    {
      label:'强行突破（武）', stat:'str', difficulty:15,
      success_text:'抢先发力，将斥候逼退。趁乱跑出了他们的视线。',
      failure_text:'没能压制，陷入对峙，双方都有人受伤。',
      success_effects:[], 
      failure_effects:[
        { type:'char_injury', target:'random_active', delta:1, count:1 },
      ],
    },
    {
      label:'甩脱追踪（智）', stat:'int', difficulty:12,
      success_text:'绕进密林，几番折返，彻底甩掉了追踪。',
      failure_text:'没能甩掉，对方一路跟了很久，队伍疲于奔命。',
      success_effects:[],
      failure_effects:[
        { type:'char_hp', target:'random_active', delta:-1, count:6 },
        { type:'party_stat', stat:'food', delta:-3 },
      ],
    },
  ],
  conditions:{ min_day:3 },
},
{
  id:'collapsed_bridge', name:'断桥', repeatable:false,
  hexagram:'未济', hint:'未济难渡，智力可通', terrain:'山涧',
  intro:'前方一座木桥已经朽烂，桥板塌了大半，下面是湍急的山涧。绕路要多走两天。',
  checks:[
    {
      label:'评估风险（智）', stat:'int', difficulty:9,
      success_text:'仔细检查了还能承重的位置，规划出一条走法。',
      failure_text:'判断失误，走到一半桥板突然断裂。',
      success_effects:[],
      failure_effects:[
        { type:'char_injury', target:'random_active', delta:1, count:1 },
        { type:'party_stat', stat:'food', delta:-2 },
      ],
      fail_ends_event:true,
    },
    {
      label:'加固桥身（武）', stat:'str', difficulty:13,
      success_text:'砍来木料，临时加固了最危险的几段，队伍小心翼翼全员通过。',
      failure_text:'木料不够，只能逐人通过，耗费了大量时间，当天粮食消耗翻倍。',
      success_effects:[],
      failure_effects:[{ type:'party_stat', stat:'food', delta:-4 }],
    },
  ],
  conditions:{},
},
{
  id:'wolves_circle', name:'狼群围营', repeatable:true,
  hexagram:'坎', hint:'坎险连至，群狼环伺', terrain:'荒野',
  intro:'半夜，营地四周出现了点点绿光。狼群无声地包围过来，篝火还没有熄，但它们没有离开的意思。',
  checks:[
    {
      label:'守住火线（武）', stat:'str', difficulty:13,
      success_text:'举火呐喊，轮流驱赶，熬到天亮，狼群终于散去。',
      failure_text:'火势减弱，狼群开始试探性地冲进来，有人被咬伤。',
      success_effects:[{ type:'char_hp', target:'all_alive', delta:-1 }],
      failure_effects:[
        { type:'char_injury', target:'random_active', delta:1, count:1 },
        { type:'char_hp', target:'all_alive', delta:-1 },
      ],
      fail_ends_event:true,
    },
    {
      label:'击杀头狼（武）', stat:'str', difficulty:16,
      success_text:'有人瞄准了最大的那头，一击命中。群狼随即溃散，还留下了一头死狼。',
      failure_text:'没有打中，狼群受惊后四散，但什么也没得到。',
      success_effects:[{ type:'party_stat', stat:'food', delta:3 }],
      failure_effects:[],
    },
  ],
  conditions:{ min_day:2 },
},
{
  id:'foraging_roots', name:'掘根', repeatable:true,
  hexagram:'颐', hint:'颐养其身，掘根果腹', terrain:'林地',
  intro:'粮食告急，有人建议挖掘林间的根茎充饥。这需要认路，也需要气力。',
  checks:[
    {
      label:'辨认可食根茎（智）', stat:'int', difficulty:10,
      success_text:'认出了几种可食的品种，标记出位置，让人去挖。',
      failure_text:'认不准，为了安全只能放弃大部分，白费了力气。',
      success_effects:[], failure_effects:[], fail_ends_event:true,
    },
    {
      label:'大量挖掘（武）', stat:'str', difficulty:12,
      success_text:'挖了整整半天，弄到了不少。根茎粗糙，但能填肚子。',
      failure_text:'土层太硬，挖到的不多，只够一两顿。',
      success_effects:[{ type:'party_stat', stat:'food', delta:6 }],
      failure_effects:[{ type:'party_stat', stat:'food', delta:2 }],
    },
  ],
  conditions:{},
},
{
  id:'old_soldier', name:'老卒', repeatable:false,
  hexagram:'既济', hint:'既济功成，老卒告退', terrain:'山道',
  intro:'路边坐着一个老人，腿上有旧伤，走不动了。他自称是溃败的兵，熟悉这一带的路。',
  checks:[
    {
      label:'甄别真伪（智）', stat:'int', difficulty:10,
      success_text:'细问之下，他确实说出了几处官道不知道的捷径，应该是真的。',
      failure_text:'问了半天，说法前后矛盾，不知真假，只能带着一肚子疑惑上路。',
      success_effects:[], failure_effects:[], fail_ends_event:true,
    },
    {
      label:'按捷径行进（智）', stat:'int', difficulty:9,
      success_text:'捷径确实存在，节省了不少脚程，还意外发现了一处避风的营地遗址。',
      failure_text:'捷径走到一半断了，只能折回，白耗了半天。',
      success_effects:[
        { type:'party_stat', stat:'food', delta:-2 },
        { type:'add_item', item:{ id:'shortcut_herb', name:'草药', quantity:3, weight:1, consumable:true, isdrug:true, 'hp回复量':1 } },
      ],
      failure_effects:[
        { type:'party_stat', stat:'food', delta:-3 },
        { type:'char_hp', target:'all_alive', delta:-1 },
      ],
    },
  ],
  conditions:{},
},
{
  id:'night_burial', name:'夜葬', repeatable:false,
  hexagram:'震', hint:'震动生敬，葬者安魂', terrain:'营地',
  intro:'有人提议，既然队伍里已经有人死了，应该在夜里做个简单的仪式，不能就这么走了。争执了很久，最终还是停下来。',
  checks:[
    {
      label:'主持仪式（智）', stat:'int', difficulty:8,
      success_text:'成功主持了仪式。',
      failure_text:'没有人知道该说什么，最后潦草收场。',
      success_effects:[{ type:'char_hp', target:'all_alive', delta:1 }],
      failure_effects:[{ type:'char_hp', target:'all_alive', delta:-1 }],
      fail_ends_event:true,
    },
    {
      label:'整理遗物（智）', stat:'int', difficulty:7,
      success_text:'遗物分发给各人保管。有人从中找到了一些还能用的东西。',
      failure_text:'遗物引发了争执，到底该谁拿，吵了很久没有结论。',
      success_effects:[{ type:'party_stat', stat:'food', delta:1 }],
      failure_effects:[{ type:'char_hp', target:'all_alive', delta:-1 }],
    },
  ],
  conditions:{ require_dead:true },
},
{
  id:'fog_morning', name:'晨雾', repeatable:true,
  hexagram:'蒙', hint:'蒙昧如雾，静待天明', terrain:'山地',
  intro:'清晨起来，四周全是白茫茫的雾。能见度不足三步，什么也看不见。众人坐在原地等了两个时辰，雾才慢慢散开。耽误了半天，但没有人受伤。',
  checks:[], intro_effects:[{ type:'party_stat', stat:'food', delta:-1 }],
  conditions:{},
},
{
  id:'rainbow', name:'虹', repeatable:true,
  hexagram:'泰', hint:'泰通顺畅，虹现吉兆', terrain:'山地',
  intro:'雨后，东方天际出现了一道完整的长虹，横跨两座山头。队伍停下来看了很久，没有人说话。这是这几天来见到的最好看的东西了。',
  checks:[], intro_effects:[],
  conditions:{},
},
{
  id:'silent_night', name:'无声之夜', repeatable:true,
  hexagram:'坤', hint:'坤静承载，万籁俱寂', terrain:'荒野',
  intro:'今夜异常安静。没有虫鸣，没有风声，连营地的火焰都烧得特别安稳。没有人解释得了，也没有人提起。早上起来，每个人都说睡得不好。',
  checks:[], intro_effects:[],
  conditions:{},
},
{
  id:'old_road_sign', name:'路碑', repeatable:false,
  hexagram:'晋', hint:'晋升前行，路碑指途', terrain:'山道',
  intro:'路边立着一块半截入土的石碑，刻着地名，但那个地方已经没有人知道在哪里了。碑上有人用炭笔写了新字：「此路不通」，字迹很新。',
  checks:[], intro_effects:[{ type:'party_stat', stat:'food', delta:-1 }],
  conditions:{},
},
{
  id:'mass_grave', name:'乱葬岗', repeatable:false,
  hexagram:'否', hint:'否闭不通，死者无名', terrain:'荒野',
  intro:'走进一片开阔地，才发现脚下踩的是松软的土，四周立着无数歪斜的木桩，没有名字。有人认出来，这是埋人的地方，不知道死的是什么人，死了多少。队伍绕道而行，没有人回头看。',
  checks:[], intro_effects:[],
  conditions:{},
},
{
  id:'first_snow', name:'初雪', repeatable:false,
  hexagram:'剥', hint:'剥落归根，初雪覆路', terrain:'山地',
  intro:'夜里下了第一场雪。不大，但早晨起来地上已经白了。脚印踩进去，发出细碎的声音。有人说，下了雪就难走了。另一个人说，下了雪就干净了。',
  checks:[], intro_effects:[{ type:'char_hp', target:'all_alive', delta:-1 }],
  conditions:{ min_day:5 },
},
{
  id:'bones_on_road', name:'路上的骸骨', repeatable:true,
  hexagram:'旅', hint:'旅途流离，白骨在野', terrain:'山道',
  intro:'路中间躺着几具骸骨，衣物早已腐烂，只剩骨头和一些零散的碎片。没有人知道他们是谁，也没有人停下来。只有走在最后的一个人悄悄回头看了一眼。',
  checks:[], intro_effects:[],
  conditions:{},
},
{
  id:'fireflies', name:'萤火', repeatable:true,
  hexagram:'丰', hint:'丰盛光明，萤火照夜', terrain:'林地',
  intro:'天黑后营地边的草丛里亮起了星星点点的光。是萤火虫，很多。有人伸手，一只落在指尖停了一会儿，然后飞走了。这是今天唯一让人觉得好的事。',
  checks:[], intro_effects:[],
  conditions:{},
},
{
  id:'sick_horse', name:'倒毙的马', repeatable:false,
  hexagram:'困', hint:'困于疲竭，马先倒毙', terrain:'山道',
  intro:'路边有一匹马，已经死了，倒在泥里，不知道死了多久。马鞍还在，但骑手不见了。陶范在旁边站了很久，最终还是动手了。',
  checks:[], intro_effects:[{ type:'party_stat', stat:'food', delta:4 }],
  conditions:{},
},
];

function createDemoAdventure() {
  return new Adventure({
    days_max: 10,
    adventurers: DEMO_ADVENTURERS,
    items: DEMO_ITEMS,
    events: DEMO_EVENTS,
  });
}

// ============================================================
// EXPORTS
// ============================================================
window.Adventure = Adventure;
window.Adventurer = Adventurer;
window.Item = Item;
window.STATUS = STATUS;
window.PHASE = PHASE;
window.createDemoAdventure = createDemoAdventure;
window.getEveningSpeech = getEveningSpeech;
