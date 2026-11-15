// Watch Together sync engine. No React in here, so it can be tested on its own.
//
// How it works: the server keeps ONE shared state per room: {playing, position, stateAt, version, episode}.
// "position" is the player time at the moment "stateAt" (server clock). So everyone can work out where the video
// should be right now: playing ? position + (serverNow - stateAt) : position.
// - When YOU play / pause / seek, the new state is sent to the server (its version goes up).
// - Only the ROOM OWNER can play, pause, seek or change episode. Everyone else follows; if a guest's player is changed
//   it is put straight back.
// - Each viewer keeps one request open (a long poll): the server answers the moment the room, the members or the
//   chat change, or after ~12 s. So changes and chat messages arrive in a fraction of a second.
// - Every second each viewer asks for the state. A higher version than the one already applied is applied to the
//   player (seek if off by more than 0.6 s, then play or pause). Our own actions are recognised by their version, so
//   nothing echoes back. Small drift while playing is corrected only past 3 s so playback does not stutter.
// - Changing episode is part of the state: everyone follows it.

export type RoomState = {
  code: string; hostId: number; hostName: string; animeId: number; provider: string; audio: string; episodeId: string; episodeNumber: string;
  animeTitle: string; poster: string; playing: boolean; position: number; stateAt: number; version: number;
};
export type Member = { userId: number; username: string; avatarUrl: string; online: boolean; host: boolean };
export type RoomMsg = { id: number; text: string; createdAt: number; username: string; avatarUrl: string; own: boolean };
export type Snapshot = { now: number; room: RoomState; members: Member[]; isHost: boolean; sig: string };
export type EpisodeRef = { provider: string; audio: string; episodeId: string; episodeNumber: string };

export interface VideoLike {
  currentTime: number;
  readonly paused: boolean;
  readonly ended: boolean;
  readonly duration: number;
  readonly readyState: number;
  play(): Promise<void>;
  pause(): void;
  addEventListener(type: string, fn: () => void): void;
  removeEventListener(type: string, fn: () => void): void;
}
export interface Transport {
  call<T>(path: string, method?: 'GET' | 'POST', body?: unknown): Promise<T>;
}
export class HttpError extends Error {
  status: number;
  constructor(message: string, status: number) { super(message); this.status = status; }
}
export type Hooks = {
  onSnapshot(s: Snapshot): void;
  onMessages(m: RoomMsg[]): void;
  onError(message: string): void;
  onBlocked(blocked: boolean): void;
  onFollow(room: RoomState): void;
  getLocalEpisode(): EpisodeRef;
  autoplayOnEpisodeChange(): boolean;
};
export type SyncOptions = { waitSeconds?: number; minGapMs?: number; driftMs?: number; clock?: () => number };

export const roomKey = (r: { provider: string; audio: string; episodeId: string }) => `${r.provider}|${r.audio}|${r.episodeId}`;
type Poll = { now: number; room: RoomState; members: Member[]; messages: RoomMsg[]; isHost: boolean; sig: string };

export class RoomSync {
  private code: string;
  private api: Transport;
  private hooks: Hooks;
  private waitSeconds: number;
  private minGapMs: number;
  private driftMs: number;
  private clock: () => number;

  private snap: Snapshot | null = null;
  private offset = 0;          // serverClock - clientClock
  private oneWay = 60;         // estimated one-way network delay (ms), measured on short requests
  private sig = '';            // the member/owner signature the server last told us (for the long poll)
  private applied = 0;         // highest room version already reflected in the player
  private pushed = '';        // the episode key we last agreed on with the room
  private localKey = '';
  // Events that our OWN seek/play/pause will cause (each expires after 3 s). They are not user actions, so they are skipped.
  private ours: Record<string, number[]> = { play: [], pause: [], seeked: [] };
  private lastLocal = 0;
  private lastPlayTry = 0;
  private mismatchAt = 0;     // when the player first disagreed with the room about playing/paused
  private lastMsg = 0;
  private seen = new Set<number>(); // chat message ids already delivered (a message we sent can also come back from the poll)
  private beatAt = 0;
  private first = true;
  private live = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private driftTimer: ReturnType<typeof setInterval> | undefined;
  private video: VideoLike | null = null;

  constructor(code: string, api: Transport, hooks: Hooks, opts: SyncOptions = {}) {
    this.code = code;
    this.api = api;
    this.hooks = hooks;
    this.waitSeconds = opts.waitSeconds ?? 12;
    this.minGapMs = opts.minGapMs ?? 150;
    this.driftMs = opts.driftMs ?? 1000;
    this.clock = opts.clock ?? (() => Date.now());
  }

  start() { if (this.live) return; this.live = true; void this.tick(); }
  stop() {
    this.live = false;
    clearTimeout(this.timer);
    this.detach();
  }
  get snapshot() { return this.snap; }

  /** The episode this viewer is currently on (call whenever the page's episode changes). */
  setLocalKey(key: string) {
    const changed = key !== this.localKey;
    this.localKey = key;
    if (!this.snap || !changed) return;
    if (key === roomKey(this.snap.room)) { this.pushed = key; return; }
    if (!this.snap.isHost) { this.hooks.onFollow(this.snap.room); return; } // guests stay on the owner's episode
    if (key !== this.pushed) { this.pushed = key; void this.pushEpisode(); }
  }

  attachVideo(v: VideoLike | null) {
    if (this.video === v) return;
    this.detach();
    this.video = v;
    if (!v) return;
    v.addEventListener('play', this.onPlay);
    v.addEventListener('pause', this.onPause);
    v.addEventListener('seeked', this.onSeeked);
    v.addEventListener('loadedmetadata', this.onMeta);
    this.driftTimer = setInterval(() => { if (this.clock() >= this.lastLocal + 2500) this.apply(false); }, this.driftMs);
    if (v.readyState >= 1 && this.snap) this.apply(true);
  }
  private detach() {
    clearInterval(this.driftTimer);
    const v = this.video;
    this.video = null;
    if (!v) return;
    v.removeEventListener('play', this.onPlay);
    v.removeEventListener('pause', this.onPause);
    v.removeEventListener('seeked', this.onSeeked);
    v.removeEventListener('loadedmetadata', this.onMeta);
  }

  async sendMessage(text: string) {
    const d = await this.api.call<{ message: RoomMsg }>(`${this.code}/messages`, 'POST', { text });
    this.lastMsg = Math.max(this.lastMsg, d.message.id);
    this.seen.add(d.message.id);
    return d.message;
  }
  async leave() {
    this.stop();
    await this.api.call(`${this.code}/leave`, 'POST').catch(() => undefined);
  }

  // ---------- polling (long poll) ----------
  private async tick() {
    if (!this.live) return;
    const first = this.first;
    const t0 = this.clock();
    let delay = this.minGapMs;
    try {
      const version = this.snap ? this.snap.room.version : 0;
      const d = first
        ? await this.api.call<Poll>(`${this.code}/join`, 'POST')
        : await this.api.call<Poll>(`${this.code}?after=${this.lastMsg}&beat=1&v=${version}&s=${encodeURIComponent(this.sig)}&wait=${this.waitSeconds}`);
      if (!this.live) return;
      const t1 = this.clock();
      if (t1 - t0 < 1500) { // a quick answer tells us the network delay and the clock difference accurately
        this.oneWay = Math.max(5, (t1 - t0) / 2);
        this.offset = d.now - (t0 + t1) / 2;
      } else {              // a held request: the answer was made just before it arrived
        this.offset = d.now - (t1 - this.oneWay);
      }
      const next: Snapshot = { now: d.now, room: d.room, members: d.members, isHost: d.isHost, sig: d.sig };
      if (first) { this.first = false; this.pushed = this.localKey; }
      this.sig = d.sig;
      this.snap = next;
      this.hooks.onSnapshot(next);
      const fresh = d.messages.filter((m) => !this.seen.has(m.id));
      if (d.messages.length) for (const m of d.messages) this.lastMsg = Math.max(this.lastMsg, m.id);
      if (fresh.length) {
        for (const m of fresh) this.seen.add(m.id);
        this.hooks.onMessages(fresh);
      }
      this.onNewVersion();
    } catch (e) {
      const status = (e as HttpError).status;
      if (status === 401 || status === 403 || status === 404) { this.live = false; this.hooks.onError((e as Error).message); return; }
      delay = 1500; // network trouble: wait a moment, then try again
    }
    if (this.live) this.timer = setTimeout(() => void this.tick(), delay);
  }

  private onNewVersion() {
    const s = this.snap;
    if (!s || s.room.version <= this.applied) return;
    this.applied = s.room.version;
    const key = roomKey(s.room);
    if (key !== this.localKey) {
      // The room moved to another episode. Follow it, unless we just changed episode ourselves and are still telling it.
      if (!s.isHost || this.localKey === this.pushed) { this.pushed = key; this.hooks.onFollow(s.room); }
      return;
    }
    this.pushed = key;
    this.apply(true);
  }

  private async pushEpisode() {
    if (!this.snap || !this.snap.isHost) return;
    try {
      const d = await this.api.call<{ version: number }>(`${this.code}/state`, 'POST', {
        playing: this.hooks.autoplayOnEpisodeChange(), position: 0, episode: this.hooks.getLocalEpisode(),
      });
      this.applied = Math.max(this.applied, d.version);
    } catch { /* the next poll shows the real state */ }
  }

  // ---------- local player events ----------
  private onMeta = () => this.apply(true);
  private onPlay = () => this.local('play');
  private onPause = () => this.local('pause');
  private onSeeked = () => this.local('seeked');
  private expectEvent(type: string) { this.ours[type].push(this.clock() + 3000); }
  private local(type: string) {
    const v = this.video;
    if (!v || v.readyState < 1) return; // the player is being torn down
    const list = this.ours[type];
    while (list.length && list[0] < this.clock()) list.shift(); // forget expectations that never happened
    if (list.length) { list.shift(); return; }                   // caused by us
    this.hooks.onBlocked(false);
    if (!this.snap || !this.snap.isHost) { setTimeout(() => this.apply(true), 30); return; } // only the owner controls playback
    this.lastLocal = this.clock();
    void this.sendState(!v.paused && !v.ended, v.currentTime);
  }
  private async sendState(playing: boolean, position: number) {
    if (!this.snap || !this.snap.isHost) return;
    try {
      const d = await this.api.call<{ version: number }>(`${this.code}/state`, 'POST', { playing, position: Math.round(position * 10) / 10 });
      this.applied = Math.max(this.applied, d.version);
    } catch { /* a missed update is corrected by the next poll */ }
  }

  // ---------- making the player match the room ----------
  private expected(r: RoomState) {
    const v = this.video;
    let pos = r.playing ? r.position + Math.max(0, (this.clock() + this.offset - r.stateAt) / 1000) : r.position;
    if (v && Number.isFinite(v.duration) && v.duration > 0) pos = Math.min(pos, v.duration);
    return pos;
  }
  private apply(force: boolean) {
    const v = this.video, s = this.snap;
    if (!v || !s || v.readyState < 1) return;
    const st = s.room;
    if (roomKey(st) !== this.localKey) return; // still moving to the room's episode
    const target = this.expected(st);
    const threshold = force ? 0.6 : st.playing ? 3 : 0.8;
    if (Math.abs(v.currentTime - target) > threshold) {
      this.expectEvent('seeked');
      v.currentTime = target;
    }
    const wantPlay = st.playing && v.paused;
    const wantPause = !st.playing && !v.paused;
    if (!wantPlay && !wantPause) { this.mismatchAt = 0; return; }
    // For the periodic check, the disagreement must last a moment: a button the user just pressed is only reported
    // by the player a tick later, and must not be undone in between.
    if (!force) {
      if (!this.mismatchAt) { this.mismatchAt = this.clock(); return; }
      if (this.clock() - this.mismatchAt < 500) return;
    }
    this.mismatchAt = 0;
    if (wantPlay) {
      if (force || this.clock() - this.lastPlayTry > 3000) {
        this.lastPlayTry = this.clock();
        this.expectEvent('play');
        v.play().then(() => this.hooks.onBlocked(false)).catch(() => { this.ours.play.pop(); this.hooks.onBlocked(true); }); // browsers may block autoplay
      }
    } else {
      this.expectEvent('pause');
      v.pause();
    }
  }
}
