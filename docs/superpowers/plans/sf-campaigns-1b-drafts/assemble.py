import pathlib, re, sys
SDD = pathlib.Path('.')

def parse(path):
    lines = path.read_text().splitlines()
    fence = False; marks = []
    for i, l in enumerate(lines):
        if l.startswith('```'): fence = not fence; continue
        if fence: continue
        m = re.match(r'^### Task ([AB]\d+):\s*(.*)$', l)
        if m: marks.append(('task', i, m.group(1), m.group(2)))
        elif re.match(r'^## ', l): marks.append(('h2', i, l[3:].strip(), None))
    return lines, marks

def keep_preamble(lines):
    out = []; para = []
    def flush():
        txt = '\n'.join(para).strip()
        para.clear()
        if not txt: return
        if re.match(r'^(> )?(Drafted|I prototyped|Every code block|<!--)', txt): return
        if txt.startswith('# ') or txt == '---': return
        out.append(txt)
    for l in lines:
        if l.strip() == '': flush(); continue
        if l.startswith('# ') or l.strip() == '---' or l.startswith('<!--'): flush(); continue
        if l.startswith('## '): flush(); continue
        para.append(l)
    flush()
    return out

def split(path):
    lines, marks = parse(path)
    tasks = []; notes = []
    first = next((m[1] for m in marks if m[0] == 'task'), len(lines))
    pre = keep_preamble(lines[:first])
    bounds = [m for m in marks]
    for idx, m in enumerate(bounds):
        end = bounds[idx + 1][1] if idx + 1 < len(bounds) else len(lines)
        if m[0] == 'task':
            # a task ends at the next task or the next level-2 heading
            tasks.append((m[2], m[3], lines[m[1] + 1:end]))
        elif m[1] >= first:
            notes.append((m[2], lines[m[1] + 1:end]))
    return pre, tasks, notes

def scrub(text):
    text = text.replace("the skeleton's", "the plan's").replace("The skeleton's", "The plan's")
    text = re.sub(r'\bthe skeleton\b', 'the plan', text)
    text = re.sub(r'\bThe skeleton\b', 'The plan', text)
    text = re.sub(r'\bskeleton\b', 'plan', text)
    return text

def assemble(header, order, drafts, out, intro_sections):
    by_id = {}; notes_all = []; pre_by_id = {}
    for d in drafts:
        pre, tasks, notes = split(SDD / d)
        for tid, title, body in tasks:
            by_id[tid] = (title, body); pre_by_id[tid] = pre
        ids = ', '.join(t[0] for t in tasks)
        for title, body in notes:
            notes_all.append((ids, title, body))
    missing = [t for t in order if t not in by_id]
    if missing: sys.exit(f'missing tasks: {missing}')
    num = {tid: i + 1 for i, tid in enumerate(order)}
    parts = [header.rstrip(), '']
    parts += intro_sections
    parts.append('## Task map\n\nTask text refers to tasks by their drafting ids. This table maps them to the numbered tasks below.\n\n| Task | Id | Title |\n|---|---|---|')
    for tid in order:
        parts.append(f'| {num[tid]} | {tid} | {by_id[tid][0]} |')
    parts.append('')
    parts.append('## Decisions made while writing the tasks\n\nThese refine the spec and the outline this plan was drafted from. The task code below already reflects them; they are collected here so a reviewer can see every deliberate deviation in one place.\n')
    for ids, title, body in notes_all:
        parts.append(f'### {title} (tasks {ids})\n')
        parts.append(scrub('\n'.join(body)).strip() + '\n')
    parts.append('---\n')
    for tid in order:
        title, body = by_id[tid]
        parts.append(f'### Task {num[tid]}: {title} [{tid}]\n')
        pre = pre_by_id[tid]
        if pre:
            parts.append('> **Before you start** (shared with the other tasks drafted alongside this one):\n>')
            for p in pre:
                for l in p.splitlines():
                    parts.append('> ' + l if not l.startswith('>') else l)
                parts.append('>')
            parts.append('')
        parts.append(scrub('\n'.join(body)).strip() + '\n')
    text = '\n'.join(parts).rstrip() + '\n'
    pathlib.Path(out).write_text(text)
    return num, text

if __name__ == '__main__':
    pass
