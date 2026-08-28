#!/usr/bin/env python3
"""Assemble the hosted single page from the parts in app/src.

    python3 app/build.py

Writes app/ts-workspace.html: one file, no build step at run time, no network
calls. The parts are concatenated in the order below and evaluated as one
script, so anything declared at the top level of one part is visible to the
rest. Order matters only for values read while loading; every part past core
declares functions, which hoist.
"""
import io
import os

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.join(HERE, "src")

PARTS = [
    "core.js",       # state, the audit trail, the stage machine, shared helpers
    "ui.js",         # asking a question, and saying a refusal out loud
    "bill.js",       # rates, margin, purchase order burn-down
    "seed.js",       # the demo workspace
    "views.js",      # the desk and the record screens
    "pipe.js",       # submissions: the guards and the numbers
    "pipeview.js",   # submissions: the board, the dialogs, one submission
    "flows.js",      # timesheets, approvals, invoices
    "shell.js",      # navigation, routing, saving, start
]


def read(name):
    with io.open(os.path.join(SRC, name), encoding="utf-8") as fh:
        return fh.read().rstrip()


def escape(text):
    # A literal </script> inside a text/plain block would close it early.
    return text.replace("</script", "<\\/script")


# The page rebuilds itself when it saves, so this function is also written into
# the output and called there. Keeping one copy means the boot path that runs on
# a published page is the same one that runs here.
BOOT = """function BOOT(){
  var css=document.getElementById("app-css").textContent;
  var st=document.createElement("style"); st.textContent=css;
  document.head.appendChild(st);
  var src=document.getElementById("app-src").textContent;
  window.BOOT=BOOT;
  try{ (new Function(src))(); }
  catch(e){
    document.body.innerHTML='<pre style="padding:2rem;font:14px ui-monospace">'+
      String(e && e.stack || e)+'</pre>';
  }
}
BOOT();"""


def main():
    src = "\n".join(read(p) for p in PARTS) + "\n"
    css = read("app.css") + "\n"

    html = (
        "<title>TS Workspace</title>\n"
        '<div id="root"></div>\n'
        '<script type="text/plain" id="app-css">' + escape(css) + "</script>\n"
        '<script type="application/json" id="app-state">null</script>\n'
        '<script type="text/plain" id="app-src">' + escape(src) + "</script>\n"
        "<script>" + BOOT + "</script>\n"
    )
    out = os.path.join(HERE, "ts-workspace.html")
    with io.open(out, "w", encoding="utf-8") as fh:
        fh.write(html)
    print("%s  %.0f KB  (%d lines from %d parts)"
          % (out, len(html) / 1024.0, len(src.splitlines()), len(PARTS)))


if __name__ == "__main__":
    main()
