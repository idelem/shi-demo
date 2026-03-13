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
      // drug reduces injury by 1 (priority), then heals hp
      const injured = this.adventurers.filter(a => a.isAlive() && a.injury > 0);
      const needHp  = this.adventurers.filter(a => a.isAlive() && a.hp < a.hpMax());
      if (!injured.length && !needHp.length) return { ok:false, msg:'无人需要治疗' };

      let target;
      if (injured.length) {
        // pick most injured
        injured.sort((a,b) => b.injury - a.injury);
        target = injured[0];
        target.injury = Math.max(0, target.injury - 1);
        target.clampHp();
        this.log.push('【医疗】' + target.name + ' 伤势减轻（injury ' + (target.injury+1) + ' → ' + target.injury + '）');
      } else {
        needHp.sort((a,b) => (a.hp/a.hpMax()) - (b.hp/b.hpMax()));
        target = needHp[0];
      }

      const hp_heal = item.props['hp回复量'] || 0;
      if (hp_heal > 0) {
        const heal = Math.min(hp_heal, target.hpMax() - target.hp);
        if (heal > 0) {
          target.hp += heal;
          this.log.push('【医疗】' + target.name + ' 恢复 ' + heal + ' 体力');
        }
      }
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

  // ── End-of-day resolution (auto eat → auto drug → consume → wound rolls) ─
  endOfDay() {
    const log = [];

    // 1. Auto-eat: sort alive by (str+sta) descending, feed until food runs out
    const eaters = this.adventurers
      .filter(a => a.isAlive() && a.hp < a.hpMax())
      .sort((a, b) => {
        const scoreB = (b.attrs.str || 0) + b.sta;
        const scoreA = (a.attrs.str || 0) + a.sta;
        return scoreB - scoreA;
      });

    for (const a of eaters) {
      const food = this.items.find(i => i.isFood());
      if (!food || food.quantity <= 0) break;
      const hp_per = food.props['hp回复量'] || 1;
      const heal = Math.min(hp_per, a.hpMax() - a.hp);
      if (heal > 0) {
        a.hp += heal;
        food.quantity--;
        if (food.quantity <= 0) this.items = this.items.filter(i => !i.isFood());
        log.push({ type:'food', name: a.name, heal });
        this.log.push('【进食】' + a.name + ' 进食，恢复 ' + heal + ' 体力');
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
    const zhi = this.adventurers.find(a => a.isActive() && a.skill === '随机恢复1人1hp');
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
// DEMO DATA
// ============================================================

const DEMO_ADVENTURERS = [
  { id:0,  name:'贞',  sta:3 },
  { id:1,  name:'目',  sta:4, int:3 },
  { id:2,  name:'朝',  sta:4 },
  { id:3,  name:'丽',  sta:3 },
  { id:4,  name:'钺',  sta:5, str:3 },
  { id:5,  name:'雍',  sta:5, str:2, int:2 },
  { id:6,  name:'幽',  sta:3, str:3 },
  { id:7,  name:'七',  sta:3 },
  { id:8,  name:'冶',  sta:4, str:1 },
  { id:9,  name:'黹',  sta:3, int:2, skill:'随机恢复1人1hp' },
  { id:10, name:'玄鸟',sta:2 },
  { id:11, name:'旬',  sta:3 },
  { id:12, name:'陶范',sta:5, str:1, skill:'能把尸体做成干粮' },
  { id:13, name:'错',  sta:3, str:1 },
  { id:20, name:'执',  sta:5, str:2, int:1 },
  { id:21, name:'左',  sta:5, str:2 },
  { id:22, name:'右',  sta:5, str:2 },
  { id:23, name:'丑',  sta:3, int:1 },
  { id:24, name:'登',  sta:3, int:1 },
  { id:25, name:'舌',  sta:3, int:1 },
  { id:26, name:'阮',  sta:3, injury:1 },
  { id:27, name:'未',  sta:3, injury:1 },
];

const DEMO_ITEMS = [
  { id:'food',  name:'干粮', quantity:14, weight:1, consumable:true,  isfood:true,  'hp回复量':1 },
  { id:'herb1', name:'草药', quantity:4,  weight:1, consumable:true,  isdrug:true,  'hp回复量':1 },
  { id:'ge',    name:'戈',   quantity:2,  weight:3, consumable:false, str:2 },
];

const DEMO_EVENTS = [
  {
    id:'ambush', name:'伏击', repeatable:true,
    intro:'林中突然杀出一队盗匪，为首者手持铜钺，眼神凶狠。队伍被前后夹击，无处可退。',
    checks:[{
      label:'武力对决', stat:'str', difficulty:16,
      success_text:'血战之后，盗匪溃散。地上横七竖八躺着几具尸体。',
      failure_text:'抵挡不住，队伍被迫分散突围，狼狈撤退。',
      success_effects:[
        { type:'add_item', item:{ id:'loot_bronze', name:'青铜短刀', quantity:1, weight:2, consumable:false, str:1 } },
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
    intro:'夜营时，营地边缘传来沉重的喘息声。篝火映出一双黄色的眼睛——是饥饿的豺狼，不止一头。',
    checks:[{
      label:'驱兽（武）', stat:'str', difficulty:14,
      success_text:'举火呐喊，兽群被驱散，只留下一地爪印。',
      failure_text:'豺狼冲入营地，撕咬人员，抢走了食物。',
      success_effects:[],
      failure_effects:[
        { type:'char_injury', target:'random_active', delta:1, count:1 },
        { type:'party_stat', stat:'food', delta:-4 },
      ],
    }],
    conditions:{},
  },
  {
    id:'hunt', name:'狩猎', repeatable:true,
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
    intro:'连日阴雨，山道突然传来轰鸣，泥石俱下，前路被堵死。',
    checks:[{
      label:'强行开路（武）', stat:'str', difficulty:18,
      success_text:'众人合力，搬开巨石，勉强打通了一条缝隙。',
      failure_text:'力气耗尽，只能绕道，多走了半天，粮食消耗倍增。',
      success_effects:[],
      failure_effects:[
        { type:'party_stat', stat:'food', delta:-6 },
        { type:'char_hp', target:'all_alive', delta:-1 },
      ],
    }],
    conditions:{},
  },
  {
    id:'plague', name:'疫病蔓延', repeatable:false,
    intro:'夜里有人突发高热，口吐黑水，营地中弥漫着腐败的气息。到早晨，已有几人神色不对。',
    checks:[{
      label:'隔离处置（智）', stat:'int', difficulty:12,
      success_text:'迅速隔离病患，烧掉污染的器具，疫情得到控制。',
      failure_text:'处置迟缓，疫病在队伍中迅速扩散，人人自危。',
      success_effects:[],
      failure_effects:[
        { type:'char_hp', target:'all_alive', delta:-2 },
        { type:'char_injury', target:'random_active', delta:1, count:2 },
      ],
    }],
    conditions:{ min_day:2 },
  },
  {
    id:'lost', name:'迷路', repeatable:true,
    intro:'雾气弥漫，向导也辨不清方向，队伍在山间转了大半天，原地打转。',
    checks:[{
      label:'辨别方向（智）', stat:'int', difficulty:11,
      success_text:'终于找到了参照物，重新确认方向，虽然耗费时间，但没有更大损失。',
      failure_text:'越走越深，有人在混乱中与大队失散。',
      success_effects:[{ type:'char_hp', target:'all_alive', delta:-1 }],
      failure_effects:[
        { type:'char_hp', target:'all_alive', delta:-1 },
        { type:'char_status', target:'random_active', status:STATUS.MISSING, count:1 },
      ],
    }],
    conditions:{},
  },
  {
    id:'river_crossing', name:'渡河', repeatable:false,
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
    intro:'有人在路边发现了一具尸体，认出是失踪的同伴。',
    checks:[],
    intro_effects:[{ type:'char_status', target:'missing', status:STATUS.DEAD, count:1 }],
    conditions:{ require_missing:true },
  },
  {
    id:'merchant', name:'行商', repeatable:false,
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
    intro:'路旁蜷缩着一个年轻人，衣衫褴褛，但身形结实。他抬起头，眼神里有一丝希望。',
    checks:[],
    recruit:{ id:100, name:'奴隶', sta:2, str:1 },
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
