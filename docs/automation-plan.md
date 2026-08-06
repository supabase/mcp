وثيقة الخطة التنفيذية — أتمتة محاكاة لجنة قانونية (عربي / English)

ملخص تنفيذي — Executive Summary

عربي:
بناء نظام بروتوتايب خفيف (CLI/خدمة محلية) يوزّع "طلب قانوني" على 5 رؤوس (Head Nodes). كل رأس يحتوي 5 محامين فرعيين: 2 للصياغة (QuestionDrafter)، 2 لربط الوقائع بالنصوص القانونية (FactLinker)، و1 لكشف التناقضات (ContradictionDetector). مخرجات الرؤوس تعرض على هيئة قضاة (Judge Panel, 5 أعضاء) لتصنيف التناقض وطلب دورات توضيح حتى الوصول لقرار نهائي.

English:
Prototype a lightweight automation (CLI or local service) that dispatches a legal request across 5 Head Nodes. Each HeadNode runs 5 subagents: 2 QuestionDrafters, 2 FactLinkers, 1 ContradictionDetector. A 5-person Judge Panel aggregates contradictions and directs iterative clarification rounds until closure.

1) التصميم المعماري / Architecture

عربي:
- واجهة الاستقبال: CLI (Typer) أو HTTP API (FastAPI) تقبل JSON/YAML وتُعيد request_id.
- Orchestrator: يجزّئ الطلب إلى 5 Heads، يدير جولات (rounds)، قوائم انتظار محلية (asyncio.Queue) أو Redis للنسخة الموزعة.
- Head Node: يحتوي على 5 Subagents تعمل بالتوازي داخل العملية (async) أو كعمليات فرعية عند الحاجة.
  - QuestionDrafter x2: يولد أسئلة متابعة أو توضيح.
  - FactLinker x2: يبحث ويربط الوقائع بمقاطع قانونية/مواد/سوابق (يرجع مراجع).
  - ContradictionDetector x1: يقارن مخرجات الوكلاء ويصنّف التناقضات.
- Judge Panel: يجمع ملخّصات الرؤوس، يصنّف نوع التناقض (صريح/استنتاجي)، ويصدر توجيهات: "اعادة صياغة" أو "قبول" أو "دمج".
- التخزين/السجلّات: SQLite + JSONL للسجلات؛ تُسجل كل جولة، مخرجات الوكلاء، وقرارات القضاة.
- تدفّق العمل (simple loop): استلام → توزيع → جمع → تقييم (قضاة) → إما قبول أو إنشاء جولة جديدة مع أسئلة واضحة → تكرار حتى الإغلاق أو بلوغ الحد.

Diagram (textual):
[Client] -> [Orchestrator] -> 5 x [HeadNode] -> each -> 5 x [Subagents]
                          \-> [Consolidator] -> [JudgePanel] -> [Orchestrator control loop]

English:
- Ingest: CLI/HTTP endpoint accepts JSON/YAML.
- Orchestrator partitions request into 5 HeadNodes, runs rounds (async queues or Redis broker for distributed mode).
- HeadNode runs 5 Subagents concurrently; their outputs are consolidated and submitted to JudgePanel.
- JudgePanel classifies contradictions and prescribes next actions (clarify/accept/merge).
- Storage: SQLite for metadata + JSONL logs for full traceability.
- Loop continues until Judges issue "accept" or max rounds reached.

2) التكنولوجيا المقترحة مع بدائل / Technology choices & alternatives

مقترح مفضّل (Prototype — تفضيل):
- لغة: Python 3.11+
- CLI: Typer
- API (اختياري): FastAPI
- نماذج: Pydantic
- تزامن: asyncio (in-process), multiprocessing لاستيعاب استدعاءات ثقيلة
- تخزين: SQLite + JSONL
- تبادل رسائل (اختياري للتوسع): Redis or RabbitMQ
- LLM/NLP: واجهة قابلة للتبديل — dummy deterministic stubs أثناء التطوير، إمكانية التكامل مع OpenAI / local LLM عبر واجهة موحّدة (adapter)

مزايا/مخاطر (مُختصر):
- Python: سريع للتطوير، مكتبات NLP متاحة؛ خطر الأداء عند التوسع — يعالج بالتوزيع.
- Go/Node.js: أداء أعلى، لكن تكلفة التطوير أعلى للنمذجة اللغوية القانونية.
- Rust: أمان/أداء لكن تكلفة برمجة عالية، غير موصى به للبروتوتايب.

اختيارات الواجهة:
- CLI أولاً (بروتوتايب سريع، سهل التجريب). لاحقاً إضافة HTTP API لتكامل أعلى.

3) نموذج البيانات / Data model (JSON)

Request template (request.json):
{
  "request_id": "<uuid>",
  "metadata": {"sender":"","received_at":"YYYY-MM-DD"},
  "facts": ["..."],
  "questions": ["..."],
  "documents": ["file.pdf","..."],
  "config": {"max_rounds":3, "head_count":5}
}

Head output (per head, per round):
{
  "head_id": 1,
  "round": 0,
  "questions": ["..."],
  "links": [{"text":"...","ref":"Article 7","confidence":0.8}],
  "contradiction": true|false,
  "notes": "..."
}

Verdict / Judge output:
{
  "decision": "clarify|accept|merge|reject",
  "reason": "...",
  "head_ids": [1,3]
}

Logs: Write JSONL entries with timestamp, request_id, component, payload.

I/O specs:
- Input: JSON or YAML file or POST body
- Output: Final verdict JSON + logs saved to logs/<request_id>.jsonl

4) خطة تنفيذية (Milestones) — بروتوتايب E2E

Milestone 1: Project scaffold + plan doc (done) — 1 day
Milestone 2: Implement Orchestrator + HeadNode stubs (async loop, logging) — 2 days
Milestone 3: Implement Subagent stubs (QuestionDrafter, FactLinker, ContradictionDetector) + deterministic behavior — 2 days
Milestone 4: JudgePanel logic & simple decision rules — 1 day
Milestone 5: E2E glue + sample inputs + README + smoke tests — 1 day
Milestone 6: Optional: Replace stubs with LLM adapter (OpenAI/local) + config — 2-3 days
Milestone 7: Optional: Add HTTP API, persistent queues (Redis), and CI smoke tests — 3-5 days

تقديرات زمنية منخفضة التفصيل: بروتوتايب لإتمام دورة واحدة: حوالي 7 أيام عمل (بدون تكامل LLM/شبكة). مع تكامل LLM والـAPI: 2-3 أسابيع.

5) سيناريو اختبار مفصّل (Sample test flow)

بيانات العيّنة (sample_input.json):
- facts: ["2025-05-01: Tenant reported leak", "Landlord repaired partially on 2025-05-15", "Agreement Article 7: landlord maintenance"]
- question: ["Is landlord liable for breach?"]

خطوات تنفيذ الاختبار:
1. إرسال sample_input.json عبر CLI.
2. Orchestrator يوزع إلى 5 Heads؛ كل Head يولد أسئلته (2)، روابطه (2)، وإشارة تناقض (bool).
3. تُجمع مخرجات الرؤوس وتُرسل إلى JudgePanel.
4. حال وجود تناقض، القضاة يصدرون قرار "clarify" مع head_ids.
5. Orchestrator يُضاف إلى request.questions أسئلة توضيحية من القضاة ويشغّل جولة جديدة.
6. تتكرّر حتى يقرر القضاة "accept" أو الوصول إلى max_rounds.
7. إخراج: logs JSONL مفصّلة لكل جولة + final_verdict.json

مخرجات متوقعة في الاختبار:
- حالات متباينة تُنتج جولات توضيح 1-2 مرة، في النهاية قرار "accept" أو بلوغ الحد (يعتمد على منطق ContradictionDetector).

الملف المحفوظ: docs/automation-plan.md

ملاحظات وقرارات مستقبلية:
- ابدأ بواجهة CLI ونماذج ثابِتة (deterministic stubs) لتثبيت المنطق، ثم اربط LLM عبر adapter.
- صُمّم الواجهات بحيث يسهل تبديل محرك NLP/LLM.
- سجّل كل الإدخالات والمخرجات بصيغة JSONL لسهولة التدقيق.

---

Action: This document is saved as a pending plan. Please choose: Approve to implement, Request edits, or Stop. / الوثيقة محفوظة كخطة معطلة (pending). الرجاء الاختيار: الموافقة للتنفيذ، طلب تعديل، أو الإيقاف.