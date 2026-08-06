تحليل التناقض النظامي — Systemic Contradiction Analysis (req-0001)

ملخّص سريع (عربي)
- الطلب: req-0001 (sample_input.json)
- سجلات مفحوصة: legal_sim/logs/run_req-0001_round_0.jsonl, run_req-0001_round_1.jsonl, run_req-0001_round_2.jsonl, verdict_req-0001_round_*.jsonl, final_req-0001.jsonl
- الاستنتاج العام: نظام الربط المبدئي أنتج تنوعاً في المراجع (Article-#) عبر الرؤوس، ما أدّى إلى إصدار قضاة لتوجيهات توضيح في كل جولة. بعد تعديل المنطق إلى مضاهاة على نصوص المقالات (Article mentions)، ظهرت توافقية (Article-7) في جولة 0، ولكن التكرارات اللاحقة أعادت تنوع المراجع بسبب تغيّر البذرة/السياق بعد إضافة أسئلة توضيحية.

Round-by-round (English summary + Arabic observations):

Round 0:
- Observed: initial outputs contain diverse links (e.g., Article-2,11,7,13,3) and one head (head_id:5) flagged contradiction=true.
- Judges: issued 'clarify' for head 5, then later an 'accept' entry referencing Article-7 (there are two verdict entries in logs for round_0: clarify then accept).
- Interpretation: two distinct snapshots were logged for round_0: an early divergent snapshot, then a harmonized snapshot (likely after head logic change or subsequent deterministic mapping). This explains the mixed verdicts.

Round 1:
- Observed: heads 1 and 5 reported links with high diversity (Article-8,1 vs Article-10,5 etc.); head flags: head 1 and 5 had contradiction true.
- Judges: requested clarification for head_ids [1,5].
- Interpretation: clarifying questions changed request context, producing new link mappings; diversity persisted in subset of heads.

Round 2:
- Observed: head 4 flagged contradiction (links Article-11 and Article-15) while others converged on fewer articles.
- Judges: no accept recorded for round 2 in separate verdict file; final file shows max_rounds_reached.

Root causes (likely):
1. Inconsistent linkage strategy: initial FactLinker fallbacks used a hash-seed mapping that is sensitive to small text changes (questions appended), causing divergent Article assignments across heads.
2. Lack of provenance/confidence: links lack source spans and confidence scores, so judges cannot weight them.
3. Race of updates / multiple snapshots: logs show repeat entries for the same round (round_0) with different outputs — implies either multiple runs or in-round updates overwrote results without clear versioning.

Recommendations (actionable):
1. Normalize linking: prefer explicit extraction of article mentions from documents/facts (regex parse) before fallback. Only use deterministic hash fallback when no explicit mention exists.
2. Attach provenance: each link should include {source_text_span, doc_id, character_offsets, confidence}. Store these in logs so Judges can ask for targeted justification.
3. Add confidence scoring & majority rule: Judges should compute a score per Article = sum(confidence) and choose predominant Article if score gap > threshold, else request clarification.
4. Targeted clarification: when asking heads to clarify, include the conflicting Article and ask "Please justify why Article-X applies, quoting the supporting sentence/paragraph." This reduces seed drift.
5. Version logs per-round: include timestamps and a per-head sequence number so multiple snapshots within a round are explicit (avoid mixed verdicts per round).
6. Make FactLinker deterministic w.r.t. same input + stable normalization (strip whitespace, normalize dates, canonicalize numbers) to avoid seed-sensitive map changes after minor question appends.

Suggested quick fixes (prioritized):
- Implement provenance fields and explicit Article extraction (regex) in HeadNode.factlinker (fast, low-risk).
- Modify JudgePanel to use majority-by-confidence and only request clarification when no clear predominant Article.
- Add a per-round snapshot id and avoid re-logging conflicting snapshots to the same round without version increment.

Deliverables produced for you here:
- Analysis document: docs/contradiction-analysis.md (this file)
- Packaged logs (zip): legal_sim/logs_req-0001.zip (created in workspace root)
- Paths to inspect raw logs:
  - legal_sim/legal_sim/logs/run_req-0001_round_0.jsonl
  - legal_sim/legal_sim/logs/verdict_req-0001_round_0.jsonl
  - legal_sim/legal_sim/logs/run_req-0001_round_1.jsonl
  - legal_sim/legal_sim/logs/verdict_req-0001_round_1.jsonl
  - legal_sim/legal_sim/logs/run_req-0001_round_2.jsonl
  - legal_sim/legal_sim/logs/final_req-0001.jsonl

Next steps I can take (pick one or let me decide):
- Implement provenance + regex Article extraction in fact linker and re-run smoke tests (recommended);
- Implement confidence & majority rule in JudgePanel and re-run tests;
- Package and upload the logs to a shared location (GitHub user-attachments) if you want to download them externally.

Findings from user evidence files (C:\Users\wesam\ملفاتي\الأدلة):
- Extracted memo: __مذكرة_١_الاعتراض_على_الفسخ_متطورة الاخيره_.docx — key excerpts:
  - Rental contract and national-address evidence contradicting the court's factual basis (doc lines showing عقد إيجار and شهادة العنوان الوطني). These are explicit documentary facts that should be matched by FactLinker before any hash fallback.
  - The memo lists audio/visual recordings and correspondences as supporting evidence (recordings referenced). Judges must be able to request quoted timestamps/segments from these artifacts to resolve disputes of fact.
  - The memo details multiple legal arguments about mis-application of law and alleged procedural/defensive omissions; these specify the exact legal points (conditions, custody, residence) that FactLinker should map to specific Articles for meaningful aggregation.

- CLAUDE.md (prompt-engineering notes): shows multiple prompt templates and role personas. Observed risk: varying prompt templates or personas (different QuestionDrafters/FactLinkers prompts) will produce inconsistent citations; standardize prompts or use a single adapter layer to ensure consistent extraction rules.

- HTML page (بوابة مجلس الشورى القضائي): UI/metadata files found but not primary evidence. They can be used for context (case meta, presentation) but do not change evidentiary facts.

Incorporated actions taken:
- Extracted DOCX text to docs/docx_extracted_1.txt and included its evidence in this analysis.

Recommendation (concrete):
- Immediately modify HeadNode.factlinker to: (1) parse explicit Article mentions; (2) attach provenance and confidence; (3) when evidence files (docx/audio/video) are present, return file anchors (docx paragraph, audio timestamp) so Judges can request targeted justifications.

I can now (autonomously) implement the factlinker changes and update logs/tests. Proceed? (yes/no)