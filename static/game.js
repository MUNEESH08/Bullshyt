(() => {
  'use strict';

  // ---------------------------------------------------------
  // State
  // ---------------------------------------------------------
  let roomCode = null;
  let playerId = null;
  let pollTimer = null;
  let failCount = 0;        // consecutive failed polls (network / server trouble)
  let missCount = 0;        // consecutive "room not found" answers
  let lastVersion = -1;     // newest server state version we have rendered
  let latestState = null;
  let selectedCardIds = new Set();
  let lastRevealId = null;
  let lastChatSeq = -1;
  let lastHandKey = '';
  let actionBusy = false;

  // Hand layout (keep CARD_W in sync with --cw in style.css)
  const CARD_W = 52;
  const MIN_STRIP = 13;     // narrowest visible slice of an overlapped card
  const MAX_STRIP = 30;     // widest slice (when you hold only a few cards)
  const MAX_SELECT = 4;

  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  const makeId = () => (window.crypto && crypto.randomUUID)
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`;

  // localStorage can throw (private mode, blocked storage) - never let that break the game
  const lsGet = (k) => { try { return localStorage.getItem(k); } catch (_) { return null; } };
  const lsSet = (k, v) => { try { localStorage.setItem(k, v); } catch (_) {} };
  const lsDel = (k) => { try { localStorage.removeItem(k); } catch (_) {} };

  // Persistent Player Profile Stats
  let profile = { played: 0, won: 0, name: 'somexmas05' };
  try { profile = Object.assign(profile, JSON.parse(lsGet('bs3p_profile') || '{}')); } catch (_) {}
  const saveProfile = () => lsSet('bs3p_profile', JSON.stringify(profile));

  // Remember which table/seat this browser has, so a refresh or dropped signal can rejoin
  const SESSION_KEY = 'bs3p_session';
  const loadSession = () => { try { return JSON.parse(lsGet(SESSION_KEY) || 'null'); } catch (_) { return null; } };
  const saveSession = (s) => lsSet(SESSION_KEY, JSON.stringify(s));

  const updateBannerStats = () => {
    const level = Math.max(1, 3 + Math.floor(profile.won / 2));
    const ranks = ['Rookie', 'Hustler', 'Bluffer', 'Capo', 'Don'];
    const rank = ranks[Math.min(ranks.length - 1, Math.floor(profile.won / 3))];
    document.getElementById('playerLevel').textContent = level;
    document.getElementById('rankLabel').textContent = rank;
    document.getElementById('playedCount').textContent = profile.played;
    document.getElementById('wonCount').textContent = profile.won;
    document.getElementById('xpBarFill').style.width = `${Math.min(100, 25 + (profile.played % 5) * 18)}%`;
  };

  // DOM Elements
  const hubScreen = document.getElementById('hubScreen');
  const tableScreen = document.getElementById('tableScreen');
  const nicknameInput = document.getElementById('nicknameInput');
  const roomCodeInput = document.getElementById('roomCodeInput');
  const hubError = document.getElementById('hubError');
  const fanEl = document.getElementById('myHandFan');

  nicknameInput.value = profile.name || 'somexmas05';
  updateBannerStats();

  // Auto-fill ?room=XXXXX invite link if opened from a friend's link
  const params = new URLSearchParams(window.location.search);
  if (params.get('room')) {
    roomCodeInput.value = params.get('room').toUpperCase();
  }

  // ---------------------------------------------------------
  // Toast + connection indicator (replaces blocking alert() popups)
  // ---------------------------------------------------------
  const toastEl = document.createElement('div');
  toastEl.id = 'toast';
  document.body.appendChild(toastEl);
  let toastTimer = null;
  function toast(message, kind = 'error') {
    toastEl.textContent = message;
    toastEl.className = `show ${kind}`;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { toastEl.className = ''; }, 3400);
  }

  const connEl = document.createElement('div');
  connEl.id = 'connPill';
  connEl.className = 'hidden';
  document.body.appendChild(connEl);
  function setConn(status) {
    if (status === 'ok') {
      connEl.className = 'hidden';
    } else if (status === 'retry') {
      connEl.textContent = 'Reconnecting…';
      connEl.className = 'retry';
    } else {
      connEl.textContent = 'Connection lost — still trying…';
      connEl.className = 'lost';
    }
  }

  // ---------------------------------------------------------
  // Network layer: timeouts, JSON-safe parsing, safe retries
  // ---------------------------------------------------------
  async function fetchJson(url, options = {}, timeoutMs = 10000) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(url, { ...options, signal: ctrl.signal, cache: 'no-store' });
      let data = null;
      try { data = await res.json(); } catch (_) { /* HTML error page or empty body */ }
      return { res, data };
    } finally {
      clearTimeout(timer);
    }
  }

  // Every POST carries a request_id. If the connection drops after the server already
  // handled it, the automatic retry is recognised and not applied a second time.
  async function apiPost(url, payload) {
    const body = JSON.stringify({ ...payload, request_id: makeId() });
    let lastMessage = 'Connection problem. Please try again.';

    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const { res, data } = await fetchJson(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body
        });
        if (res.ok && data) {
          setConn('ok');
          return data;
        }
        lastMessage = (data && data.error) || `Server error (${res.status})`;
        const transient = (res.status >= 500 || res.status === 429) && !(data && data.retryable === false);
        if (!transient) throw Object.assign(new Error(lastMessage), { fatal: true });
      } catch (err) {
        if (err.fatal) throw err;
        if (err.name === 'AbortError') lastMessage = 'Connection timed out. Please try again.';
      }
      setConn('retry');
      await sleep(450 * (attempt + 1));
    }
    throw new Error(lastMessage);
  }

  // ---------------------------------------------------------
  // Tabs, favourite
  // ---------------------------------------------------------
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
      document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
      btn.classList.add('active');
      document.getElementById(btn.dataset.tab).classList.add('active');
    });
  });

  document.getElementById('favBtn').addEventListener('click', (e) => {
    e.currentTarget.classList.toggle('liked');
    e.currentTarget.innerHTML = e.currentTarget.classList.contains('liked') ? '&#9829;' : '&#9825;';
  });

  // Warn right away if the server has no shared storage (the usual cause of "room not found")
  fetchJson('/api/health', {}, 6000).then(({ data }) => {
    if (data && data.ok === false && data.message) hubError.textContent = data.message;
  }).catch(() => {});

  // ---------------------------------------------------------
  // Create / Join
  // ---------------------------------------------------------
  document.getElementById('createRoomBtn').addEventListener('click', async (e) => {
    hubError.textContent = '';
    const btn = e.currentTarget;
    btn.disabled = true;
    const name = nicknameInput.value.trim() || 'somexmas05';
    const ammo_enabled = document.getElementById('ammoToggle').checked;
    profile.name = name;
    saveProfile();

    try {
      const data = await apiPost('/api/create', { name, ammo_enabled });
      enterTable(data.state.code, data.player_id, data.state);
    } catch (err) {
      hubError.textContent = err.message;
    } finally {
      btn.disabled = false;
    }
  });

  document.getElementById('joinRoomBtn').addEventListener('click', async (e) => {
    hubError.textContent = '';
    const btn = e.currentTarget;
    const name = nicknameInput.value.trim() || 'Player';
    const code = roomCodeInput.value.trim().toUpperCase();
    if (!code) {
      hubError.textContent = 'Enter a 5-letter room code first.';
      return;
    }
    profile.name = name;
    saveProfile();

    // If this browser already has a seat at that table, ask the server to restore it
    const saved = loadSession();
    const payload = { name, code };
    if (saved && saved.code === code && saved.player_id) payload.player_id = saved.player_id;

    btn.disabled = true;
    try {
      const data = await apiPost('/api/join', payload);
      enterTable(data.state.code, data.player_id, data.state);
    } catch (err) {
      hubError.textContent = err.message;
    } finally {
      btn.disabled = false;
    }
  });

  function enterTable(code, pid, initialState) {
    clearTimeout(pollTimer);
    roomCode = code;
    playerId = pid;
    selectedCardIds.clear();
    lastVersion = -1;
    lastHandKey = '';
    lastChatSeq = -1;
    failCount = 0;
    missCount = 0;
    actionBusy = false;
    // Don't replay an old Bullsh!t pop-up when (re)joining mid-game
    lastRevealId = initialState.last_reveal ? initialState.last_reveal.id : null;

    saveSession({ code, player_id: pid, name: profile.name, active: true });

    hubScreen.classList.remove('active');
    tableScreen.classList.add('active');
    document.getElementById('displayRoomCode').textContent = code;

    applyState(initialState);
    schedulePoll(1200);
  }

  function leaveTable() {
    clearTimeout(pollTimer);
    const saved = loadSession();
    // Keep the seat on file so typing the code again restores it, but don't auto-resume
    if (saved) saveSession({ ...saved, active: false });
    roomCode = null;
    latestState = null;
    setConn('ok');
    tableScreen.classList.remove('active');
    hubScreen.classList.add('active');
  }

  function roomGone() {
    toast('This table has expired or no longer exists.');
    const saved = loadSession();
    if (saved && saved.code === roomCode) lsDel(SESSION_KEY);
    leaveTable();
    hubError.textContent = 'That table is gone. Create a new one or join with a fresh code.';
  }

  // Reconnect automatically after a page refresh / app switch
  (async function resumeSession() {
    const saved = loadSession();
    if (!saved || !saved.active || !saved.code || !saved.player_id) return;
    if (params.get('room') && params.get('room').toUpperCase() !== saved.code) return;
    try {
      const { res, data } = await fetchJson(
        `/api/state/${encodeURIComponent(saved.code)}?player_id=${encodeURIComponent(saved.player_id)}`, {}, 8000);
      if (res.ok && data && data.state && data.state.players.some(p => p.is_me)) {
        enterTable(saved.code, saved.player_id, data.state);
      } else if (res.status === 404) {
        lsDel(SESSION_KEY);
      }
    } catch (_) { /* offline right now: stay on the hub, player can press JOIN */ }
  })();

  // ---------------------------------------------------------
  // Polling: one request at a time, backs off on trouble, ignores stale answers
  // ---------------------------------------------------------
  function schedulePoll(delay) {
    clearTimeout(pollTimer);
    if (!roomCode) return;
    pollTimer = setTimeout(pollState, delay);
  }

  async function pollState() {
    if (!roomCode || !playerId) return;
    const polledRoom = roomCode;
    let nextDelay = document.hidden ? 4000 : 1200;

    try {
      const url = `/api/state/${encodeURIComponent(polledRoom)}?player_id=${encodeURIComponent(playerId)}&since=${lastVersion}`;
      const { res, data } = await fetchJson(url, {}, 8000);
      if (polledRoom !== roomCode) return;           // we left while waiting

      if (res.status === 404) {
        missCount++;
        if (missCount >= 3) { roomGone(); return; }  // not a one-off blip
        throw new Error('room not found (yet)');
      }
      if (!res.ok || !data) throw new Error('bad response');

      missCount = 0;
      failCount = 0;
      setConn('ok');
      if (data.state) applyState(data.state);
    } catch (_) {
      failCount++;
      setConn(failCount >= 3 ? 'lost' : 'retry');
      nextDelay = Math.min(5000, 1200 + failCount * 800);
    }
    schedulePoll(nextDelay);
  }

  document.addEventListener('visibilitychange', () => { if (!document.hidden && roomCode) schedulePoll(0); });
  window.addEventListener('online', () => { if (roomCode) schedulePoll(0); });

  // Drop answers older than what is already on screen (slow responses can arrive out of order)
  function applyState(state) {
    if (typeof state.version === 'number') {
      if (state.version < lastVersion) return;
      lastVersion = state.version;
    }
    renderState(state);
  }

  // ---------------------------------------------------------
  // Rendering
  // ---------------------------------------------------------
  function renderBullets(containerEl, count, enabled) {
    if (!enabled) {
      containerEl.innerHTML = '';
      return;
    }
    let html = '';
    for (let i = 0; i < 3; i++) {
      const spent = i >= count ? 'spent' : '';
      html += `<span class="bullet-icon ${spent}">🔸</span>`;
    }
    containerEl.innerHTML = html;
  }

  const rankPlural = (name) => (name === 'Six' ? 'SIXES' : `${name.toUpperCase()}S`);

  function renderState(state) {
    latestState = state;
    const me = state.players.find(p => p.is_me);
    if (!me) return;

    // Order the other 2 seats relative to "me" clockwise
    const opp1 = state.players.find(p => p.seat === (me.seat + 1) % 3);
    const opp2 = state.players.find(p => p.seat === (me.seat + 2) % 3);

    // Bottom Seat (Me)
    document.getElementById('meNameLabel').textContent = me.name;
    renderBullets(document.getElementById('meBullets'), me.bullets, state.ammo_enabled);
    document.getElementById('meDealer').classList.toggle('hidden', !me.is_dealer);

    updateOpponentSeat(opp1, {
      slot: 'seatOpponent1', inviteBtn: 'inviteSeat1Btn', avatar: 'opp1Avatar', cards: 'opp1Cards',
      dealer: 'opp1Dealer', name: 'opp1Name', bullets: 'opp1Bullets', defaultLabel: 'Player 2', emoji: '🕵️',
      isTurn: state.status === 'playing' && opp1 && state.turn_index === opp1.seat
    }, state.ammo_enabled, state.status);

    updateOpponentSeat(opp2, {
      slot: 'seatOpponent2', inviteBtn: 'inviteSeat2Btn', avatar: 'opp2Avatar', cards: 'opp2Cards',
      dealer: 'opp2Dealer', name: 'opp2Name', bullets: 'opp2Bullets', defaultLabel: 'Player 3', emoji: '🎩',
      isTurn: state.status === 'playing' && opp2 && state.turn_index === opp2.seat
    }, state.ammo_enabled, state.status);

    // Center Pile & Status Banner
    document.getElementById('tableStatusBanner').textContent = state.banner_text;
    const pileBadge = document.getElementById('pileCountBadge');
    if (state.pile_count > 0) {
      pileBadge.textContent = state.pile_count;
      pileBadge.classList.remove('hidden');
    } else {
      pileBadge.classList.add('hidden');
    }

    const turnHud = document.getElementById('turnHud');
    const actionRow = document.getElementById('actionButtonsRow');
    const endgameBox = document.getElementById('endgameBox');

    if (state.status === 'waiting') {
      turnHud.classList.add('hidden');
      actionRow.classList.add('hidden');
      endgameBox.classList.add('hidden');
      clearHand();
    } else if (state.status === 'playing') {
      turnHud.classList.remove('hidden');
      actionRow.classList.remove('hidden');
      endgameBox.classList.add('hidden');

      document.getElementById('requiredRankLabel').textContent = rankPlural(state.current_rank_name);
      const lastPlayEl = document.getElementById('lastPlayLabel');
      if (state.last_play) {
        lastPlayEl.textContent = `Last: ${state.last_play.player_name} declared ${state.last_play.label}`;
        lastPlayEl.classList.remove('hidden');
      } else {
        lastPlayEl.classList.add('hidden');
      }

      renderMyHand(state.my_hand);
      updateActionButtons();
    } else if (state.status === 'finished') {
      turnHud.classList.add('hidden');
      actionRow.classList.add('hidden');
      clearHand();
      endgameBox.classList.remove('hidden');

      const listEl = document.getElementById('rankingsList');
      listEl.innerHTML = state.rankings.map(r => `
        <div class="ranking-item">
          <span>#${r.place} ${escapeHtml(r.name)}</span>
          <strong>${r.cards_left === 0 ? 'WINNER 🏆' : r.cards_left + ' cards'}</strong>
        </div>
      `).join('');

      if (!endgameBox.dataset.counted) {
        endgameBox.dataset.counted = '1';
        profile.played += 1;
        if (state.rankings[0] && state.rankings[0].id === me.id) profile.won += 1;
        saveProfile();
        updateBannerStats();
      }
    }

    if (state.status === 'playing') {
      delete endgameBox.dataset.counted;
    }

    // Bullsh!t Reveal Pop-up
    const revealBox = document.getElementById('revealBox');
    if (state.last_reveal && state.last_reveal.id !== lastRevealId) {
      lastRevealId = state.last_reveal.id;
      document.getElementById('revealTitle').textContent = state.last_reveal.lied
        ? `🚨 ${state.last_reveal.accused_name.toUpperCase()} LIED!`
        : `✅ ${state.last_reveal.accused_name.toUpperCase()} TOLD THE TRUTH!`;
      document.getElementById('revealCardsRow').innerHTML = state.last_reveal.cards.map(c => {
        const isRed = c.suit === '♥' || c.suit === '♦';
        return `<div class="mini-face-card ${isRed ? 'red' : ''}"><span>${c.rank}</span><span>${c.suit}</span></div>`;
      }).join('');
      revealBox.classList.remove('hidden');
      setTimeout(() => revealBox.classList.add('hidden'), 5000);
    }

    // Chat Messages (re-render only when a new message has arrived)
    if (state.chat && state.chat_seq !== lastChatSeq) {
      lastChatSeq = state.chat_seq;
      const chatBox = document.getElementById('chatMessages');
      chatBox.innerHTML = state.chat.map(m =>
        `<div class="chat-msg"><strong>${escapeHtml(m.sender)}:</strong> ${escapeHtml(m.text)}</div>`
      ).join('');
      chatBox.scrollTop = chatBox.scrollHeight;
    }
  }

  function updateOpponentSeat(opp, ids, ammoEnabled, status) {
    const slotEl = document.getElementById(ids.slot);
    slotEl.classList.toggle('active-turn', Boolean(ids.isTurn));

    if (!opp) {
      document.getElementById(ids.inviteBtn).classList.remove('hidden');
      document.getElementById(ids.avatar).classList.add('hidden');
      document.getElementById(ids.cards).classList.add('hidden');
      document.getElementById(ids.dealer).classList.add('hidden');
      document.getElementById(ids.name).textContent = ids.defaultLabel;
      renderBullets(document.getElementById(ids.bullets), 3, ammoEnabled);
      return;
    }

    document.getElementById(ids.inviteBtn).classList.add('hidden');
    const avatarEl = document.getElementById(ids.avatar);
    avatarEl.textContent = ids.emoji;
    avatarEl.classList.remove('hidden');

    const cardsEl = document.getElementById(ids.cards);
    if (status === 'playing') {
      cardsEl.textContent = opp.card_count;
      cardsEl.classList.remove('hidden');
    } else {
      cardsEl.classList.add('hidden');
    }

    document.getElementById(ids.dealer).classList.toggle('hidden', !opp.is_dealer);
    document.getElementById(ids.name).textContent = opp.name;
    renderBullets(document.getElementById(ids.bullets), opp.bullets, ammoEnabled);
  }

  // ---------------------------------------------------------
  // Overlapped hand
  //   - cards sit side by side, each one covering most of the previous card,
  //     so only the rank number of each is visible
  //   - touching a card expands it: it grows to its full face (taller and wider),
  //     the cards to its right slide over to make room
  //   - touch it again to collapse it. Up to 4 cards can be expanded to play.
  // ---------------------------------------------------------
  function clearHand() {
    lastHandKey = '';
    selectedCardIds.clear();
    fanEl.replaceChildren();
  }

  function buildCard(card) {
    const isRed = card.suit === '♥' || card.suit === '♦';
    const el = document.createElement('div');
    el.className = `playing-card${isRed ? ' red' : ''}`;
    el.dataset.id = card.id;
    el.innerHTML =
      `<span class="pc-rank">${card.rank}</span>` +
      `<span class="pc-suit">${card.suit}</span>` +
      `<span class="pc-rank-br">${card.rank}</span>`;
    return el;
  }

  function renderMyHand(hand) {
    // forget selections for cards that left my hand (just played / pile moved)
    const valid = new Set(hand.map(c => c.id));
    for (const id of Array.from(selectedCardIds)) {
      if (!valid.has(id)) selectedCardIds.delete(id);
    }

    // Rebuild the DOM only when the hand really changed, so polling never makes
    // the cards flicker, collapse or jump back to the start of the scroll.
    const key = hand.map(c => c.id).join('|');
    if (key !== lastHandKey) {
      lastHandKey = key;
      const keepScroll = fanEl.scrollLeft;
      const track = document.createElement('div');
      track.className = 'hand-track';
      hand.forEach(card => track.appendChild(buildCard(card)));
      fanEl.replaceChildren(track);
      fanEl.scrollLeft = keepScroll;
    }
    syncSelection();
    layoutHand();
  }

  function syncSelection() {
    const track = fanEl.firstElementChild;
    if (!track) return;
    for (const el of track.children) {
      el.classList.toggle('selected', selectedCardIds.has(el.dataset.id));
    }
  }

  // Work out how much of each card stays visible so the whole hand fits the screen.
  // If even the narrowest slice doesn't fit (very large hands) the row scrolls sideways.
  function layoutHand() {
    const track = fanEl.firstElementChild;
    if (!track || !track.children.length) return;
    const cards = track.children;
    const n = cards.length;

    const cs = getComputedStyle(fanEl);
    const avail = fanEl.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
    const W = cards[0].offsetWidth || CARD_W;

    // A selected card that is NOT last pushes its right neighbour out by a full card width
    let expanded = 0;
    for (let i = 0; i < n - 1; i++) if (cards[i].classList.contains('selected')) expanded++;
    const slices = n - 1 - expanded;

    let strip = slices > 0 ? (avail - W - expanded * W) / slices : MAX_STRIP;
    strip = Math.max(MIN_STRIP, Math.min(MAX_STRIP, strip));

    track.style.setProperty('--s', `${strip.toFixed(1)}px`);
    track.classList.toggle('tight', strip < 18);
  }

  fanEl.addEventListener('click', (e) => {
    const el = e.target.closest('.playing-card');
    if (!el) return;
    const id = el.dataset.id;

    if (selectedCardIds.has(id)) {
      selectedCardIds.delete(id);
    } else if (selectedCardIds.size < MAX_SELECT) {
      selectedCardIds.add(id);
    } else {
      el.classList.remove('shake');
      void el.offsetWidth;                // restart the animation
      el.classList.add('shake');
      toast(`You can play up to ${MAX_SELECT} cards at a time.`, 'info');
      return;
    }
    syncSelection();
    layoutHand();
    updateActionButtons();
  });

  let resizeFrame = null;
  window.addEventListener('resize', () => {
    cancelAnimationFrame(resizeFrame);
    resizeFrame = requestAnimationFrame(layoutHand);
  });

  // ---------------------------------------------------------
  // Action buttons (one place decides what is enabled)
  // ---------------------------------------------------------
  function updateActionButtons() {
    const st = latestState;
    if (!st || st.status !== 'playing') return;
    const me = st.players.find(p => p.is_me);
    if (!me) return;

    const isMyTurn = st.turn_index === me.seat;
    const count = selectedCardIds.size;
    const rank = rankPlural(st.current_rank_name);

    const playBtn = document.getElementById('playCardsBtn');
    playBtn.disabled = actionBusy || !isMyTurn || count === 0 || count > MAX_SELECT;
    playBtn.textContent = count > 0
      ? `PLAY ${count} ${count > 1 ? rank : st.current_rank_name.toUpperCase()}`
      : `PLAY ${rank}`;

    const canCallBs = Boolean(
      st.last_play &&
      st.last_play.player_id !== me.id &&
      (!st.ammo_enabled || me.bullets > 0)
    );
    document.getElementById('callBsBtn').disabled = actionBusy || !canCallBs;

    const passBtn = document.getElementById('passWinBtn');
    if (st.pending_winner_id && st.pending_winner_id !== me.id) {
      passBtn.classList.remove('hidden');
    } else {
      passBtn.classList.add('hidden');
    }
    passBtn.disabled = actionBusy;
  }

  // Runs one game action: blocks double-taps, shows errors as a toast, and
  // re-syncs with the server if the action was rejected (e.g. someone else was faster).
  async function runAction(request, onSuccess) {
    if (actionBusy || !roomCode) return;
    actionBusy = true;
    updateActionButtons();
    try {
      const data = await request();
      if (onSuccess) onSuccess();
      if (data && data.state) applyState(data.state);
    } catch (err) {
      toast(err.message);
      schedulePoll(0);
    } finally {
      actionBusy = false;
      updateActionButtons();
    }
  }

  document.getElementById('playCardsBtn').addEventListener('click', () => {
    if (selectedCardIds.size === 0) return;
    runAction(
      () => apiPost('/api/play', { code: roomCode, player_id: playerId, card_ids: Array.from(selectedCardIds) }),
      () => selectedCardIds.clear()
    );
  });

  document.getElementById('callBsBtn').addEventListener('click', () => {
    runAction(() => apiPost('/api/call_bs', { code: roomCode, player_id: playerId }));
  });

  document.getElementById('passWinBtn').addEventListener('click', () => {
    runAction(() => apiPost('/api/pass_win', { code: roomCode, player_id: playerId }));
  });

  document.getElementById('playAgainBtn').addEventListener('click', () => {
    runAction(() => apiPost('/api/restart', { code: roomCode, player_id: playerId }));
  });

  // ---------------------------------------------------------
  // Invite link, leave, chat
  // ---------------------------------------------------------
  const copyInviteLink = async () => {
    const url = `${window.location.origin}/?room=${roomCode}`;
    try { await navigator.clipboard.writeText(url); } catch (_) { window.prompt('Copy this invite link:', url); }
    const pill = document.getElementById('copyInviteBtn');
    const prev = pill.innerHTML;
    pill.textContent = 'INVITE LINK COPIED!';
    setTimeout(() => { pill.innerHTML = prev; }, 2000);
  };

  document.getElementById('copyInviteBtn').addEventListener('click', copyInviteLink);
  document.getElementById('inviteSeat1Btn').addEventListener('click', copyInviteLink);
  document.getElementById('inviteSeat2Btn').addEventListener('click', copyInviteLink);
  document.getElementById('leaveTableBtn').addEventListener('click', leaveTable);

  document.getElementById('chatForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const input = document.getElementById('chatInput');
    const text = input.value.trim();
    if (!text || !roomCode) return;
    input.value = '';
    try {
      const data = await apiPost('/api/chat', { code: roomCode, player_id: playerId, text });
      applyState(data.state);
    } catch (err) {
      input.value = text;                 // give the message back so it isn't lost
      toast(err.message);
    }
  });

  document.getElementById('toggleChatLogBtn').addEventListener('click', () => {
    document.getElementById('chatDrawer').classList.toggle('hidden');
  });
  document.getElementById('closeChatBtn').addEventListener('click', () => {
    document.getElementById('chatDrawer').classList.add('hidden');
  });
  document.getElementById('quickRankBtn').addEventListener('click', () => {
    toast('Rank loop: A → 2 → 3 → 4 → 5 → 6 → 7 → 8 → 9 → 10 → J → Q → K → A', 'info');
  });

  function escapeHtml(str) {
    return String(str).replace(/[&<>"']/g, m => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[m]));
  }
})();
