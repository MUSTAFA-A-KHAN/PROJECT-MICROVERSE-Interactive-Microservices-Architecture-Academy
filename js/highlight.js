/* ==========================================================================
   Microverse — a small, dependency-free syntax highlighter.
   Supports the languages this course uses: Go, YAML, SQL, Dockerfile, Bash,
   JSON, Protobuf, HTTP, PromQL and plain text. Returns one HTML string per
   line so code blocks can render line numbers and per-line highlights.
   ========================================================================== */
window.MV = window.MV || {};

(function (MV) {
  'use strict';

  const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const words = (list) => new RegExp('\\b(?:' + list.split(/\s+/).join('|') + ')\\b', 'y');
  const wordsI = (list) => new RegExp('\\b(?:' + list.split(/\s+/).join('|') + ')\\b', 'iy');

  const R = {
    lineComment: /\/\/[^\n]*/y,
    blockComment: /\/\*[\s\S]*?\*\//y,
    hashComment: /#[^\n]*/y,
    dqString: /"(?:\\.|[^"\\\n])*"/y,
    sqString: /'(?:\\.|[^'\\\n])*'/y,
    number: /\b(?:0[xX][\da-fA-F_]+|\d[\d_]*(?:\.\d+)?(?:[eE][+-]?\d+)?(?:ms|s|m|h|Mi|Gi|Ki|m)?)\b/y,
    func: /\b[A-Za-z_]\w*(?=\s*\()/y,
    ident: /\b[A-Za-z_]\w*\b/y,
  };

  const LANGS = {
    go: [
      ['com', R.lineComment],
      ['com', R.blockComment],
      ['str', /`[^`]*`/y],
      ['str', R.dqString],
      ['str', /'(?:\\.|[^'\\\n])+'/y],
      ['kw', words('break case chan const continue default defer else fallthrough for func go goto if import interface map package range return select struct switch type var')],
      ['builtin', words('append cap clear close copy delete len make max min new panic print println recover nil true false iota')],
      ['type', words('bool byte complex64 complex128 error float32 float64 int int8 int16 int32 int64 rune string uint uint8 uint16 uint32 uint64 uintptr any comparable')],
      ['num', R.number],
      ['fn', R.func],
      ['type', /\b[A-Z]\w*\b/y],
      ['plain', R.ident],
      ['punct', /:=|[{}()[\];,.]|&&|\|\||<-|[=!<>]=?|[+\-*/%&|^]/y],
    ],
    proto: [
      ['com', R.lineComment],
      ['com', R.blockComment],
      ['str', R.dqString],
      ['kw', words('syntax package import option service rpc returns message enum repeated optional map stream oneof reserved')],
      ['type', words('double float int32 int64 uint32 uint64 sint32 sint64 fixed32 fixed64 bool string bytes')],
      ['num', R.number],
      ['type', /\b[A-Z]\w*\b/y],
      ['plain', R.ident],
      ['punct', /[{}()[\];,.=<>]/y],
    ],
    yaml: [
      ['com', /(?<=^|\s)#[^\n]*/my],
      ['str', R.dqString],
      ['str', R.sqString],
      ['var', /\$\{[^}\n]*\}/y],
      ['key', /(?<=^[ \t]*(?:-[ \t]+)?)[\w.\-/]+(?=[ \t]*:(?:[ \t]|$))/my],
      ['builtin', words('true false null yes no')],
      ['num', /(?<![\w.-])\d[\d.]*(?:Mi|Gi|Ki|m|s|ms|%)?(?![\w.-])/y],
      ['punct', /^[ \t]*-(?=[ \t])|[|>](?=[ \t]*$)|---/my],
    ],
    sql: [
      ['com', /--[^\n]*/y],
      ['com', R.blockComment],
      ['str', R.sqString],
      ['var', /\$\d+/y],
      ['kw', wordsI('select from where and or not insert into values update set delete create table index unique primary key foreign references on conflict do nothing returning begin commit rollback transaction isolation level read committed repeatable serializable for skip locked nowait join left right inner outer group by order asc desc limit offset having as default null is in exists case when then else end if alter add column drop constraint check cascade explain analyze with using distinct count sum avg now interval concurrently lock share mode')],
      ['type', wordsI('uuid text varchar bigint bigserial serial integer int smallint numeric decimal boolean bool timestamptz timestamp jsonb json char date')],
      ['builtin', wordsI('true false')],
      ['num', R.number],
      ['fn', R.func],
      ['plain', R.ident],
      ['punct', /[(),;.*=<>]/y],
    ],
    dockerfile: [
      ['com', /(?<=^|\s)#[^\n]*/my],
      ['kw', /(?<=^\s*)(?:FROM|RUN|COPY|ADD|WORKDIR|ENV|ARG|EXPOSE|USER|ENTRYPOINT|CMD|HEALTHCHECK|LABEL|VOLUME|SHELL|STOPSIGNAL|ONBUILD)\b/imy],
      ['kw', /\bAS\b/y],
      ['str', R.dqString],
      ['str', R.sqString],
      ['var', /\$\{[^}\n]*\}|\$[A-Za-z_]\w*/y],
      ['builtin', /--[\w-]+(?:=[^\s]*)?/y],
      ['num', R.number],
      ['punct', /[\[\],&|\\]/y],
    ],
    bash: [
      ['com', /(?<=^|\s)#[^\n]*/my],
      ['str', R.dqString],
      ['str', R.sqString],
      ['var', /\$\{[^}\n]*\}|\$[A-Za-z_]\w*|\$\d/y],
      ['kw', words('if then else elif fi for in do done case esac while until function return export local')],
      ['fn', /(?<=^\s*(?:\$\s+)?)(?:docker|kubectl|go|curl|make|migrate|psql|redis-cli|grpcurl|helm|git|npm|npx|python|python3|node|wrk|hey|k6|cd|echo|cat)\b/my],
      ['builtin', /(?<=\s)--?[\w-]+/y],
      ['num', R.number],
      ['punct', /[|&;><\\]/y],
    ],
    json: [
      ['key', /"(?:\\.|[^"\\\n])*"(?=\s*:)/y],
      ['str', R.dqString],
      ['builtin', words('true false null')],
      ['num', /-?\b\d+(?:\.\d+)?(?:[eE][+-]?\d+)?\b/y],
      ['punct', /[{}[\],:]/y],
    ],
    http: [
      ['kw', /(?<=^)(?:GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\b/my],
      ['type', /HTTP\/\d(?:\.\d)?/y],
      ['num', /(?<=HTTP\/\d(?:\.\d)? )\d{3}/y],
      ['key', /(?<=^)[A-Za-z][\w-]*(?=:\s)/my],
      ['str', R.dqString],
      ['builtin', words('true false null')],
      ['num', /-?\b\d+(?:\.\d+)?\b/y],
      ['punct', /[{}[\],:]/y],
    ],
    promql: [
      ['com', R.hashComment],
      ['str', R.dqString],
      ['fn', words('rate irate increase sum avg max min count histogram_quantile topk bottomk by without on ignoring group_left group_right absent clamp_min clamp_max delta deriv label_replace')],
      ['num', /\b\d+(?:\.\d+)?[smhdwy]?\b/y],
      ['key', /(?<=\{|,\s*)[a-z_]\w*(?==~|=|!=|!~)/y],
      ['punct', /[{}()[\],=~!<>/*+-]/y],
    ],
    text: [],
  };
  LANGS.golang = LANGS.go;
  LANGS.yml = LANGS.yaml;
  LANGS.sh = LANGS.bash;
  LANGS.shell = LANGS.bash;
  LANGS.console = LANGS.bash;
  LANGS.docker = LANGS.dockerfile;
  LANGS.protobuf = LANGS.proto;
  LANGS.plaintext = LANGS.text;
  LANGS.txt = LANGS.text;
  LANGS.makefile = LANGS.bash;
  LANGS.env = LANGS.bash;

  function tokenize(code, lang) {
    const rules = LANGS[lang] || LANGS.text;
    const out = [];
    let plain = '';
    let i = 0;
    const flushPlain = () => { if (plain) { out.push(['', plain]); plain = ''; } };
    while (i < code.length) {
      let matched = false;
      for (let r = 0; r < rules.length; r++) {
        const [cls, re] = rules[r];
        re.lastIndex = i;
        const m = re.exec(code);
        if (m && m.index === i && m[0].length > 0) {
          flushPlain();
          out.push([cls === 'plain' ? '' : cls, m[0]]);
          i += m[0].length;
          matched = true;
          break;
        }
      }
      if (!matched) { plain += code[i]; i++; }
    }
    flushPlain();
    return out;
  }

  /** Highlight `code` and return an array of HTML strings, one per line. */
  function highlightLines(code, lang) {
    const tokens = tokenize(code.replace(/\r\n?/g, '\n'), (lang || 'text').toLowerCase());
    const lines = [''];
    for (const [cls, text] of tokens) {
      const parts = text.split('\n');
      parts.forEach((part, idx) => {
        if (idx > 0) lines.push('');
        if (!part) return;
        lines[lines.length - 1] += cls ? `<span class="tk-${cls}">${esc(part)}</span>` : esc(part);
      });
    }
    return lines;
  }

  MV.highlight = {
    lines: highlightLines,
    html: (code, lang) => highlightLines(code, lang).join('\n'),
    escape: esc,
    supports: (lang) => !!LANGS[(lang || '').toLowerCase()],
  };
})(window.MV);
