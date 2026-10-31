import fetch from 'node-fetch';
import sax, { SAXStream, QualifiedTag } from 'sax';
import { DateTime } from 'luxon';
import cron from 'node-cron';
import { gunzipSync } from 'zlib';
import { EPGIndex, EPGServiceOptions, Programme, StremioEpgVideo } from './types';
import { normalizeChannelName } from './nameMap';

export class EPGService {
  private url: string;
  private additionalUrls: string[];
  private index: EPGIndex = { byChannel: {}, nowNext: {}, channelNames: {}, nameToIds: {}, updatedAt: 0 };
  private schedule?: any;
  private fallbackTz?: string;
  private fallbackTzFilter?: (channelId: string) => boolean;

  constructor(opts: EPGServiceOptions) {
  this.url = opts.url;
  this.additionalUrls = opts.additionalUrls || [];
  this.fallbackTz = opts.fallbackTimeZone;
  this.fallbackTzFilter = opts.fallbackTimeZoneFilter;
    const cronSpec = opts.refreshCron || '0 */10 * * *'; // every 3 hours
    this.schedule = cron.schedule(cronSpec, () => {
      this.refresh().catch((error: any) => console.error('[EPG] Scheduled refresh failed:', error?.message || error));
    }, { timezone: 'Europe/Rome' });
  }

  public getIndex(): EPGIndex { return this.index; }

  public getProgrammesForDate(candidateChannelIds: string[], dateUtcStr: string, channelMetaId: string): StremioEpgVideo[] {
    const dayStart = new Date(`${dateUtcStr}T00:00:00.000Z`).getTime();
    const dayEnd = new Date(`${dateUtcStr}T23:59:59.999Z`).getTime();
    if (isNaN(dayStart) || isNaN(dayEnd)) return [];

    let bestProgs: Programme[] = [];
    for (const chId of candidateChannelIds) {
      const arr = this.index.byChannel[chId];
      if (arr && arr.length > 0) {
        const matches = arr.filter(p => p.stop > dayStart && p.start < dayEnd);
        if (matches.length > bestProgs.length) {
          bestProgs = matches;
        }
      }
    }

    return dedupeByStart(bestProgs).map(p => {
      const startIso = new Date(p.start).toISOString();
      const endIso = new Date(p.stop).toISOString();
      const durationMin = Math.max(1, Math.round((p.stop - p.start) / 60000));
      return {
        id: `${channelMetaId}:epg:${startIso}`,
        title: p.title || 'Live',
        overview: p.desc || undefined,
        released: startIso,
        startTime: startIso,
        endTime: endIso,
        runtime: `${durationMin} min`,
        releaseInfo: startIso.slice(0, 4),
      };
    });
  }

  public getUpcomingProgrammes(candidateChannelIds: string[], channelMetaId: string, hoursAhead = 24): StremioEpgVideo[] {
    const now = Date.now();
    const windowStart = now - 2 * 60 * 60 * 1000;
    const windowEnd = now + hoursAhead * 60 * 60 * 1000;

    let bestProgs: Programme[] = [];
    for (const chId of candidateChannelIds) {
      const arr = this.index.byChannel[chId];
      if (arr && arr.length > 0) {
        const matches = arr.filter(p => p.stop > windowStart && p.start < windowEnd);
        if (matches.length > bestProgs.length) {
          bestProgs = matches;
        }
      }
    }

    return dedupeByStart(bestProgs).map(p => {
      const startIso = new Date(p.start).toISOString();
      const endIso = new Date(p.stop).toISOString();
      const durationMin = Math.max(1, Math.round((p.stop - p.start) / 60000));
      return {
        id: `${channelMetaId}:epg:${startIso}`,
        title: p.title || 'Live',
        overview: p.desc || undefined,
        released: startIso,
        startTime: startIso,
        endTime: endIso,
        runtime: `${durationMin} min`,
        releaseInfo: startIso.slice(0, 4),
      };
    });
  }

  public async refresh(): Promise<void> {
    const urls = [this.url, ...this.additionalUrls].filter(Boolean);
    const failures: string[] = [];
    // Merge each source as it is parsed instead of retaining every full guide
    // in an indexes[] array. On small Render instances, holding three complete
    // XMLTV indexes plus the merged result can exceed Node's heap limit.
    const byChannel: Record<string, Programme[]> = {};
    const channelNames: Record<string, string[]> = {};
    let successfulSources = 0;

    for (const url of urls) {
      try {
        const res = await fetch(url, { timeout: 30000 } as any);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const bytes = Buffer.from(await res.arrayBuffer());
        let xml = bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b
          ? gunzipSync(bytes).toString('utf8')
          : bytes.toString('utf8');
        // Some XMLTV hosts prepend/append non-XML text (for example a
        // proxy/banner response). Keep only the actual XMLTV document.
        const rootStart = xml.search(/<tv(?:\\s|>)/i);
        const rootEnd = xml.toLowerCase().lastIndexOf('</tv>');
        if (rootStart < 0 || rootEnd < rootStart) {
          throw new Error(`Response does not contain an XMLTV <tv> document (starts: ${xml.slice(0, 160).replace(/\\s+/g, ' ')})`);
        }
        xml = xml.slice(rootStart, rootEnd + 5);
        const index = this.parse(xml);
        successfulSources++;

        for (const [id, programmes] of Object.entries(index.byChannel)) {
          (byChannel[id] ||= []).push(...programmes);
        }
        for (const [id, names] of Object.entries(index.channelNames)) {
          const merged = channelNames[id] ||= [];
          for (const name of names) if (!merged.includes(name)) merged.push(name);
        }
        // index, xml and bytes become collectible before the next source is fetched.
      } catch (error: any) {
        failures.push(`${url}: ${error?.message || error}`);
      }
    }
    if (!successfulSources) throw new Error(`All EPG sources failed: ${failures.join('; ')}`);

    const now = Date.now();
    const nowNext: EPGIndex['nowNext'] = {};
    for (const [id, programmes] of Object.entries(byChannel)) {
      programmes.sort((a, b) => a.start - b.start);
      const unique = new Map<number, Programme>();
      for (const programme of programmes) {
        if (!unique.has(programme.start)) unique.set(programme.start, programme);
      }
      byChannel[id] = Array.from(unique.values());
      const arr = byChannel[id];
      const currentIndex = arr.findIndex(p => now >= p.start && now < p.stop);
      nowNext[id] = currentIndex >= 0
        ? { now: arr[currentIndex], next: arr[currentIndex + 1] }
        : { next: arr.find(p => p.start > now) };
    }

    const nameToIds: Record<string, string[]> = {};
    const addId = (key: string, id: string) => {
      if (!nameToIds[key]) nameToIds[key] = [];
      if (!nameToIds[key].includes(id)) nameToIds[key].push(id);
    };
    for (const [id, names] of Object.entries(channelNames)) {
      for (const name of names) {
        const key = normalizeChannelName(name);
        if (!key) continue;
        addId(key, id);
        // The open UK guide splits ITV1 by region (e.g. ITV1 Anglia).
        // Include those regional feeds for the single ITV1 stream, but never +1.
        const compact = key.replace(/\\s+/g, '');
        if (/^itv1(?!plusone)[a-z]+$/.test(compact)) addId('itv1', id);
      }
    }
    this.index = { byChannel, nowNext, channelNames, nameToIds, updatedAt: Date.now() };
    console.log('[EPG] Refresh complete:', { sources: successfulSources, channels: Object.keys(byChannel).length, programmes: Object.values(byChannel).reduce((total, items) => total + items.length, 0) });
    if (failures.length) console.warn('[EPG] Some sources failed:', failures.join('; '));
  }

  private parse(xml: string): EPGIndex {
    const parser = sax.parser(true, { trim: true, lowercase: true });
    const byChannel: Record<string, Programme[]> = {};
    const channelNames: Record<string, string[]> = {};

    let curProg: Partial<Programme> | null = null;
    let curTag: string | null = null;
    let curText: string = '';
    let inChannel = false;
    let curChannelId: string | null = null;

    parser.onopentag = (node: any) => {
      curTag = node.name;
      curText = '';
      if (node.name === 'programme') {
        // attributes: channel, start, stop in xmltv format: YYYYMMDDHHmmss + tz
        const ch = String((node.attributes as any).channel || '');
        const startRaw = String((node.attributes as any).start || '');
        const stopRaw = String((node.attributes as any).stop || '');
        curProg = {
          channel: ch,
          start: this.xmltvToMs(startRaw, ch),
          stop: this.xmltvToMs(stopRaw, ch),
        };
      } else if (node.name === 'channel') {
        inChannel = true;
        curChannelId = String((node.attributes as any).id || '');
        if (curChannelId && !channelNames[curChannelId]) channelNames[curChannelId] = [];
      }
    };

    parser.ontext = (t: string) => {
      curText += t;
    };

    parser.onclosetag = (name: string) => {
      const tag = name.toLowerCase();
      if (tag === 'title' && curProg) {
        curProg.title = (curText || '').trim();
      } else if (tag === 'desc' && curProg) {
        curProg.desc = (curText || '').trim();
      } else if (tag === 'display-name' && inChannel && curChannelId) {
        const t = (curText || '').trim();
        if (t) channelNames[curChannelId].push(t);
      } else if (tag === 'channel') {
        inChannel = false;
        curChannelId = null;
      } else if (tag === 'programme') {
        if (curProg && typeof curProg.start === 'number' && typeof curProg.stop === 'number' && curProg.channel) {
          const p = curProg as Programme;
          if (!byChannel[p.channel]) byChannel[p.channel] = [];
          byChannel[p.channel].push(p);
        }
        curProg = null;
      }
      curText = '';
      curTag = null;
    };

    parser.write(xml).close();

    // Sort programmes and build now/next table
    const now = Date.now();
    const nowNext: EPGIndex['nowNext'] = {};
    for (const [ch, arr] of Object.entries(byChannel)) {
      arr.sort((a, b) => a.start - b.start);
      // find current and next
      let current: Programme | undefined;
      let next: Programme | undefined;
      for (let i = 0; i < arr.length; i++) {
        const p = arr[i];
        if (now >= p.start && now < p.stop) {
          current = p;
          next = arr[i + 1];
          break;
        }
        if (p.start > now) { next = p; break; }
      }
      nowNext[ch] = { now: current, next };
    }

    // Build reverse mapping: normalized display name -> candidate tvg-ids
    const nameToIds: Record<string, string[]> = {};
    for (const [id, names] of Object.entries(channelNames)) {
      for (const nm of names) {
        const k = normalizeChannelName(nm);
        if (!k) continue;
        if (!nameToIds[k]) nameToIds[k] = [];
        if (!nameToIds[k].includes(id)) nameToIds[k].push(id);
      }
    }

    return { byChannel, nowNext, channelNames, nameToIds, updatedAt: Date.now() };
  }

  private xmltvToMs(v: string, channelId?: string): number {
    // XMLTV style: 20240917101500 +0200 or 20240917101500+0200 or no offset.
    const m = v.match(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(?:\s*([+-]\d{4}))?/);
    if (!m) return Date.now();
    const [_, Y, M, D, h, mnt, s, tz] = m;
    const baseISO = `${Y}-${M}-${D}T${h}:${mnt}:${s}`;
    if (tz) {
      // parse with explicit offset -> UTC ms
      const sign = tz.startsWith('-') ? -1 : 1;
      const tzh = parseInt(tz.slice(1, 3), 10);
      const tzm = parseInt(tz.slice(3, 5), 10);
      const offsetMinutes = sign * (tzh * 60 + tzm);
      const dt = DateTime.fromISO(baseISO, { zone: 'utc' }).minus({ minutes: offsetMinutes });
      return dt.toMillis();
    }
    // No offset provided: if configured, treat as local time in fallbackTz
    try {
      if (this.fallbackTz && (!this.fallbackTzFilter || this.fallbackTzFilter(channelId || ''))) {
        const dtLocal = DateTime.fromFormat(`${Y}${M}${D}${h}${mnt}${s}`, 'yyyyLLddHHmmss', { zone: this.fallbackTz });
        if (dtLocal.isValid) return dtLocal.toUTC().toMillis();
      }
    } catch {}
    // Fallback: interpret as UTC
    const dtUtc = DateTime.fromISO(baseISO, { zone: 'utc' });
    return (dtUtc.isValid ? dtUtc.toMillis() : Date.now());
  }
}

export function pickTvgIdForName(name: string, candidates: string[]): string | null {
  const norm = normalizeChannelName(name);
  // exact match preferred
  for (const c of candidates) {
    if (normalizeChannelName(c) === norm) return c;
  }
  // fallback: if numbered variants like "X 1" or "X 2", just strip the trailing index and try again
  const stripped = norm.replace(/\s+\d+$/, '');
  for (const c of candidates) {
    if (normalizeChannelName(c).replace(/\s+\d+$/, '') === stripped) return c;
  }
  return candidates[0] || null;
}

// XMLTV sources can list the same programme more than once; Stremio keys shows by id ({channel}:epg:{start})
function dedupeByStart(progs: Programme[]): Programme[] {
  const seen = new Set<number>();
  return progs.filter(p => (seen.has(p.start) ? false : (seen.add(p.start), true)));
}
