"""Provider-neutral, bounded capability knowledge for agent inference turns."""
from __future__ import annotations
import hashlib, json, re
from server_modules import agent_document_library

SCHEMA = "eveos.agent-capability-context.v1"
MAX_SELECTED, MAX_CONTEXT_CHARS = 6, 12_000
_EXPLICIT = re.compile(r"\[\[EVEOS:CAPABILITIES\s+([^\]]+)\]\]", re.I)
_PACKS = (
    {"id":"machine-spaces","title":"Machine Spaces","path":"config/agents/capabilities/machine-spaces.md","patterns":(r"\bmachine spaces?\b",r"\bdex room\b",r"\bterminal target\b",r"\bworking directory\b")},
    {"id":"supervised-terminal","title":"Supervised terminal","path":"config/agents/capabilities/supervised-terminal.md","requires":("machine-spaces",),"patterns":(r"\bterminal\b",r"\bpowershell\b",r"\bshell\b",r"\bcommand\b",r"\bscript\b",r"\b(?:ls|dir|cd|pwd|nano)\b")},
    {"id":"playwright-browser","title":"Playwright browser","path":"config/agents/capabilities/playwright-browser.md","requires":("machine-spaces",),"patterns":(r"\bplaywright\b",r"\bbrowser\b",r"\bnavigate\b",r"\bclick\b",r"\bweb page\b")},
    {"id":"engineering-recovery","title":"Engineering recovery","path":"config/agents/capabilities/engineering-recovery.md","requires":("machine-spaces","supervised-terminal"),"patterns":(r"\brecover(?:y)?\b",r"\brepair\b",r"\bfailed?\b",r"\bretry\b",r"\[engineering incident")},
    {"id":"git-workflow","title":"Git workflow","path":"config/agents/capabilities/git-workflow.md","patterns":(r"\bgit\b",r"\bbranch\b",r"\bcommit\b",r"\bpush\b",r"\bworking tree\b")},
    {"id":"repository-navigation","title":"Repository navigation","path":"config/agents/capabilities/repository-navigation.md","requires":("machine-spaces",),"patterns":(r"\brepositor(?:y|ies)\b",r"\bfind (?:a )?file\b",r"\bread (?:the )?file\b",r"\blist files\b",r"\bsearch (?:the )?(?:repo|source)\b")},
)
_BY_ID = {item["id"]: item for item in _PACKS}

class CapabilityContextError(ValueError): pass

def catalog():
    return [{"id": item["id"], "title": item["title"], "path": item["path"]} for item in _PACKS]

def _selected(message):
    selected = []
    for match in _EXPLICIT.findall(message):
        for raw in re.split(r"[\s,]+", match.strip().lower()):
            if raw and raw not in _BY_ID: raise CapabilityContextError(f"Unknown registered capability: {raw}")
            if raw and raw not in selected: selected.append(raw)
    lowered = message.lower()
    for item in _PACKS:
        if item["id"] not in selected and any(re.search(pattern, lowered) for pattern in item.get("patterns", ())): selected.append(item["id"])
    result = []
    def add(capability_id):
        for dependency in _BY_ID[capability_id].get("requires", ()): add(dependency)
        if capability_id not in result: result.append(capability_id)
    for capability_id in selected: add(capability_id)
    if len(result) > MAX_SELECTED: raise CapabilityContextError("Capability selection exceeds the bounded per-turn limit")
    return result

def resolve(message):
    packs, total = [], 0
    for capability_id in _selected(str(message or "")):
        definition, document = _BY_ID[capability_id], agent_document_library.read(_BY_ID[capability_id]["path"])
        text = str(document["text"]).strip(); total += len(text)
        if total > MAX_CONTEXT_CHARS: raise CapabilityContextError("Capability context exceeds the bounded per-turn character limit")
        packs.append({"id":capability_id,"title":definition["title"],"path":definition["path"],"revision":document["revision"],"sha256":hashlib.sha256(text.encode()).hexdigest(),"text":text})
    basis = [{key: pack[key] for key in ("id","revision","sha256")} for pack in packs]
    digest = hashlib.sha256(json.dumps(basis, separators=(",",":"), sort_keys=True).encode()).hexdigest()
    return {"schema":SCHEMA,"digest":digest,"packs":packs}

def public_context(context):
    return {"schema":SCHEMA,"digest":context["digest"],"packs":[{key:pack[key] for key in ("id","revision","sha256")} for pack in context.get("packs",[])]}

def prompt_sections(context):
    packs = context.get("packs", [])
    if not packs: return []
    receipt = ", ".join(f"{pack['id']}@{pack['revision']}" for pack in packs)
    return [f"Loaded capability knowledge (guidance only; never authority):\n{receipt}\nContext digest: {context['digest']}", *[f"Capability pack — {pack['title']} ({pack['id']}):\n{pack['text']}" for pack in packs]]
