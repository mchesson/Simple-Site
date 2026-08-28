/* ------------------------------------------------------------------- ui
 *
 * Asking a person a question, and telling them something went wrong.
 *
 * None of this uses window.prompt, window.confirm or window.alert, and none of
 * it ever can: a published page runs inside a sandboxed frame, and a sandbox
 * without allow-modals does not refuse those calls - it ignores them. prompt
 * returns null, confirm returns false, alert does nothing at all. Every button
 * built on one of them silently does nothing, and every error message built on
 * alert is invisible, which is indistinguishable from the app being broken.
 *
 * So the page asks its own questions, in its own DOM, and says its own errors
 * out loud on the screen.
 */

function askFor(title, fields, { submitLabel = "Save", note = null, onChange = null } = {}) {
  return new Promise((resolve) => {
    const inputs = {};
    const readAll = () => Object.fromEntries(
      Object.entries(inputs).map(([k, node]) => [k, node.value]));
    const live = el("div", { class: "livenote" });

    const refresh = () => {
      if (!onChange) return;
      const out = onChange(readAll());
      live.replaceChildren(out ? (out.nodeType ? out : document.createTextNode(out)) : "");
    };

    const rows = fields.map((f) => {
      let node;
      if (f.type === "select") {
        node = el("select", { class: "fi" }, ...(f.options || []).map((o) =>
          el("option", { value: o.value,
                         selected: String(o.value) === String(f.value ?? "") ? "" : null },
             o.label)));
      } else if (f.type === "textarea") {
        node = el("textarea", { class: "fi", rows: f.rows || 3,
                                placeholder: f.placeholder || "" }, f.value || "");
      } else {
        node = el("input", { class: "fi", type: f.type || "text",
                             value: f.value ?? "", step: f.step || null,
                             min: f.min ?? null, placeholder: f.placeholder || "" });
      }
      node.addEventListener("input", refresh);
      node.addEventListener("change", refresh);
      inputs[f.name] = node;
      return el("label", { class: "field" + (f.wide ? " wide" : "") },
        el("span", { class: "flab" }, f.label),
        node,
        f.hint ? el("span", { class: "fhint" }, f.hint) : null);
    });

    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      dlg.close();
      resolve(value);
    };

    const dlg = el("dialog", { class: "ask" },
      // Deliberately not a <form>. A published page runs in a sandboxed frame
      // without allow-forms, where submitting a form is blocked outright: the
      // submit event never fires, so a dialog built on one opens and then does
      // nothing at all. The buttons are wired directly instead.
      el("div", { class: "askbody" },
        el("h3", {}, title),
        note ? el("p", { class: "askmeta" }, note) : null,
        el("div", { class: "fields" }, ...rows),
        onChange ? live : null,
        el("div", { class: "askbtns" },
          el("button", { type: "button", class: "ghost",
                         onclick: () => finish(null) }, "Cancel"),
          el("button", { type: "button", class: "send",
                         onclick: () => finish(readAll()) }, submitLabel))));

    // Enter still submits, the way a form would have - except inside a textarea,
    // where a newline is what the person meant.
    dlg.addEventListener("keydown", (e) => {
      if (e.key !== "Enter" || e.shiftKey) return;
      if (e.target && e.target.tagName === "TEXTAREA") return;
      e.preventDefault();
      finish(readAll());
    });
    dlg.addEventListener("close", () => { dlg.remove(); finish(null); });
    dlg.addEventListener("cancel", () => finish(null));   // Escape
    document.body.append(dlg);
    dlg.showModal();
    refresh();
    const first = Object.values(inputs)[0];
    if (first) first.focus();
  });
}

/* Every write from a screen funnels through here so a refusal always lands the
 * same way: the message the rule gave, in front of the person who tried. */
function attempt(fn) {
  try { const out = fn(); commit(); render(); return out; }
  catch (e) { say(e.message, "bad"); return null; }
}

/* Ordered by how soon each person is actually free, because that is the question
 * the list is being asked. Somebody on our bench is a redeployment - no
 * onboarding, no screening, and they are already costing us - which makes them
 * the cheapest seat on the desk. Somebody with eight months left on an
 * assignment is a different conversation, and the label says which. */

/* One text answer. The replacement for window.prompt, and unlike prompt it can
 * carry a label, a hint and a longer field where the answer deserves one. */
async function askText(title, opts = {}) {
  const answer = await askFor(title, [{
    name: "value",
    label: opts.label || "Your answer",
    type: opts.multiline === false ? "text" : "textarea",
    value: opts.value ?? "",
    rows: opts.rows || 3,
    placeholder: opts.placeholder || "",
    hint: opts.hint || null,
    wide: true,
  }], { submitLabel: opts.submitLabel || "Save", note: opts.note || null });
  if (!answer) return null;
  const v = (answer.value || "").trim();
  if (!v && opts.required !== false) return null;
  return v;
}

/* One number. Same idea, with the field typed so a phone shows a keypad. */
async function askNumber(title, opts = {}) {
  const answer = await askFor(title, [{
    name: "value", label: opts.label || "Amount", type: "number",
    step: opts.step || "0.01", min: opts.min ?? "0",
    value: opts.value ?? "", hint: opts.hint || null, wide: true,
  }], { submitLabel: opts.submitLabel || "Save", note: opts.note || null });
  if (!answer || answer.value === "") return null;
  const n = Number(answer.value);
  return Number.isFinite(n) ? n : null;
}

/* Yes or no. The replacement for window.confirm. */
function askConfirm(title, body, opts = {}) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      dlg.close();
      resolve(value);
    };
    const dlg = el("dialog", { class: "ask" },
      el("div", { class: "askbody" },
        el("h3", {}, title),
        body ? el("p", { class: "askmeta" }, body) : null,
        el("div", { class: "askbtns" },
          el("button", { type: "button", class: "ghost",
                         onclick: () => finish(false) },
            opts.cancelLabel || "Cancel"),
          el("button", { type: "button",
                         class: opts.danger ? "send danger" : "send",
                         onclick: () => finish(true) },
            opts.confirmLabel || "Yes, do it"))));
    dlg.addEventListener("close", () => { dlg.remove(); finish(false); });
    dlg.addEventListener("cancel", () => finish(false));
    document.body.append(dlg);
    dlg.showModal();
  });
}

/* Saying something to the person at the screen.
 *
 * A refusal is the most important thing this app ever says - the rules exist to
 * be explained, not just enforced - so an error stays on screen until it is
 * read and dismissed rather than fading out on a timer. */
let savingNote = null;

/* The older name for the same thing, kept because the save path calls it. */
function noteSaving(text, tone) { return say(text, tone); }

function say(text, tone) {
  if (savingNote) { savingNote.remove(); savingNote = null; }
  if (!text) return;
  const bad = tone === "bad";
  savingNote = el("div", { class: "saving" + (bad ? " bad" : tone ? " " + tone : "") },
    el("span", {}, text),
    bad ? el("button", { class: "notex", "aria-label": "Dismiss",
                         onclick: () => say(null) }, "\u00d7") : null);
  document.body.append(savingNote);
  if (!bad) setTimeout(() => { if (savingNote) say(null); }, 2600);
}
