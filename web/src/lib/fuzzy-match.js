// The Quick Open fuzzy matcher — pure functions, no DOM, no fetch, no Vue.
//
// The scoring rules of the quick-open spec §2.4 live here and nowhere else:
// a case-insensitive smart subsequence over the whole workspace-relative
// path, scoring contiguity, word boundaries and segment starts, with a
// bare-name match outranking a mid-path match at equal structure. The module
// returns index spans, never marked-up strings — the dialog renders the
// slices itself as `<span>` elements.

// Characters after which a match counts as a word-boundary match.
const SEPARATORS = '/._-';

// What one unmatched query character costs. The match is a subsequence — the
// query's characters must appear in order — but one character of the query may
// go unmatched (a typo, or a letter the user only thought was in the name:
// the spec's `usred` finding `src/core/editorfs/redact.py`). Everything else
// must still be in order, so this is tolerance, not licence.
const SKIP_PENALTY = 4;

// The bare-name bonus: a match that spells the start of the file's own name
// contiguously outranks a mid-path match at equal structure, because that is
// what the user usually means.
const BARE_NAME_BONUS = 15;

const isUpper = (ch) => ch >= 'A' && ch <= 'Z';
const isLower = (ch) => ch >= 'a' && ch <= 'z';

/**
 * A match position is a word boundary when it starts the path, follows a
 * separator, or follows a lower→upper case change (camelCase).
 */
function isWordBoundary(path, pos) {
  if (pos === 0) return true;
  const prev = path[pos - 1];
  if (SEPARATORS.includes(prev)) return true;
  return isLower(prev) && isUpper(path[pos]);
}

/** A match position starts a path segment when it follows `/` (or the path start). */
function isSegmentStart(path, pos) {
  return pos === 0 || path[pos - 1] === '/';
}

/** Score for matching one query character at `pos`, given the previous match position. */
function charScore(path, pos, prevPos) {
  let score = 1;
  if (isWordBoundary(path, pos)) score += 8;
  if (isSegmentStart(path, pos)) score += 4;
  if (prevPos === pos - 1) score += 5; // contiguity
  return score;
}

/**
 * Best strict subsequence match of `chars` (already lowercased) against
 * `path`: `{ score, indices }` or `null`. A dynamic program over the query's
 * candidate positions, so the chosen alignment is the best one, not the
 * greedy one.
 */
function bestSubsequence(chars, path) {
  const p = path.toLowerCase();
  const n = chars.length;
  const m = p.length;
  if (n === 0) return { score: 0, indices: [] };
  if (n > m) return null;

  // Per query index, the candidate positions of that character in the path.
  const positions = [];
  for (let i = 0; i < n; i++) {
    const at = [];
    for (let j = i; j < m; j++) if (p[j] === chars[i]) at.push(j);
    if (at.length === 0) return null;
    positions.push(at);
  }

  // rows[i] = Map(pathIndex -> { score, prev }): the best score matching
  // chars[0..i] with chars[i] at that path index, and the index it chained from.
  let rows = new Map();
  for (const j of positions[0]) {
    rows.set(j, { score: charScore(path, j, -1), prev: -1 });
  }
  const layers = [rows];
  for (let i = 1; i < n; i++) {
    const next = new Map();
    for (const j of positions[i]) {
      let best = null;
      for (const [pj, entry] of rows) {
        if (pj >= j) break;
        const score = entry.score + charScore(path, j, pj);
        if (!best || score > best.score) best = { score, prev: pj };
      }
      if (best) next.set(j, best);
    }
    if (next.size === 0) return null;
    rows = next;
    layers.push(rows);
  }

  // Pick the best final position, then walk the chain back for the indices.
  let bestJ = -1;
  let bestEntry = null;
  for (const [j, entry] of rows) {
    if (!bestEntry || entry.score > bestEntry.score) {
      bestEntry = entry;
      bestJ = j;
    }
  }
  const indices = new Array(n);
  let j = bestJ;
  for (let i = n - 1; i >= 0; i--) {
    indices[i] = j;
    j = layers[i].get(j).prev;
  }
  return { score: bestEntry.score, indices };
}

/**
 * Match `query` against `path` as a case-insensitive smart subsequence.
 *
 * Returns `{ score, spans }` for a match, `null` when the query cannot be
 * matched (all but at most one of its characters must appear in order).
 * `spans` are non-overlapping, in-order `[start, end)` index pairs into the
 * path string, covering exactly the matched characters — never marked-up
 * strings; the dialog renders the slices itself.
 *
 * An empty query matches everything with score 0 and no spans.
 */
export function fuzzyMatch(query, path) {
  if (typeof query !== 'string' || typeof path !== 'string') return null;
  if (query === '') return { score: 0, spans: [] };

  const chars = Array.from(query.toLowerCase());
  const baseStart = path.lastIndexOf('/') + 1;

  // The strict match first, then one attempt per skipped query character;
  // the best total score wins (the penalty keeps a skipped character last
  // resort against an equal otherwise-match).
  let best = null;
  for (let skip = -1; skip < chars.length; skip++) {
    const kept =
      skip < 0 ? chars : chars.slice(0, skip).concat(chars.slice(skip + 1));
    const match = bestSubsequence(kept, path);
    if (!match) continue;
    const score = match.score - (skip < 0 ? 0 : SKIP_PENALTY);
    if (best && best.score >= score) continue;

    // Bare-name bonus: the match spells the start of the basename
    // contiguously — the user typed the file's name, not a path fragment.
    const indices = match.indices;
    const bare =
      indices.length > 0 &&
      indices[0] === baseStart &&
      indices.every((v, i) => i === 0 || v === indices[i - 1] + 1);
    best = { score: score + (bare ? BARE_NAME_BONUS : 0), indices };
  }
  if (!best) return null;

  // Merge consecutive indices into non-overlapping, in-order spans.
  const indices = best.indices;
  const spans = [];
  let start = indices[0];
  let prev = indices[0];
  for (let k = 1; k < indices.length; k++) {
    if (indices[k] === prev + 1) {
      prev = indices[k];
    } else {
      spans.push([start, prev + 1]);
      start = prev = indices[k];
    }
  }
  spans.push([start, prev + 1]);

  return { score: best.score, spans };
}

/** The tree's own ordering: `(name.lower(), name)` per segment. */
function comparePaths(a, b) {
  const as = a.split('/');
  const bs = b.split('/');
  const len = Math.min(as.length, bs.length);
  for (let i = 0; i < len; i++) {
    const al = as[i].toLowerCase();
    const bl = bs[i].toLowerCase();
    if (al !== bl) return al < bl ? -1 : 1;
    if (as[i] !== bs[i]) return as[i] < bs[i] ? -1 : 1;
  }
  return as.length - bs.length;
}

/**
 * Rank `paths` against `query`: matched paths sorted by score (best first),
 * ties broken by the tree's own ordering so the list is deterministic.
 * Each row is `{ path, score, spans }`. Paths that do not match are omitted.
 * An empty query matches everything with score 0, in tree order.
 */
export function rankMatches(query, paths) {
  const rows = [];
  for (const path of paths) {
    const match = fuzzyMatch(query, path);
    if (match) rows.push({ path, score: match.score, spans: match.spans });
  }
  rows.sort((a, b) => b.score - a.score || comparePaths(a.path, b.path));
  return rows;
}
