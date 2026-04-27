import { marked } from "marked";
import type { PrMeta } from "./types.ts";

/**
 * Wraps the comment-builder's markdown in a self-contained HTML page that
 * mimics how it would render on a real GitHub PR — PR description block on
 * top, releasebot comment block below, both styled like GitHub's own
 * timeline-item chrome.
 *
 * Purpose: QA only. Lets a reviewer eyeball "would this look right on a real
 * PR?" without actually posting anything. Composes the comment generator's
 * output verbatim — never duplicates the comment-rendering logic.
 *
 * Markdown rendering uses marked in GFM mode so tables, fenced code, task
 * lists, and <details> work. No sanitization: input is from our own pipeline
 * + the PR author (already trusted enough that GitHub itself renders it),
 * and the file is local-only QA.
 */
export function buildCommentPreviewHtml(args: {
  pr: PrMeta;
  commentMarkdown: string;
}): string {
  const { pr, commentMarkdown } = args;
  marked.setOptions({ gfm: true, breaks: false });
  const prBodyHtml = marked.parse(pr.body || "_(PR description is empty)_", { async: false }) as string;
  const commentHtml = marked.parse(commentMarkdown, { async: false }) as string;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>cutter comment preview · PR #${pr.number}</title>
<style>
  :root { color-scheme: light; }
  body {
    font: 14px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", "Noto Sans", Helvetica, Arial, sans-serif;
    background: #f6f8fa;
    color: #1f2328;
    margin: 0;
    padding: 2rem;
  }
  .page { max-width: 920px; margin: 0 auto; }
  .preview-note {
    font-size: 12px; color: #59636e;
    background: #fff8c5; border: 1px solid #d4a72c66;
    border-radius: 6px; padding: 8px 12px; margin: 0 0 1rem;
  }
  .pr-title {
    font-size: 32px; font-weight: 400; line-height: 1.25;
    margin: 0 0 16px; color: #1f2328;
  }
  .pr-title .pr-number { color: #59636e; font-weight: 300; }
  .pr-title a { color: inherit; text-decoration: none; }
  .pr-title a:hover { color: #0969da; }
  .timeline-item { display: flex; gap: 16px; margin-bottom: 16px; }
  .avatar {
    width: 40px; height: 40px; border-radius: 50%;
    color: #fff; display: flex; align-items: center; justify-content: center;
    font-weight: 700; font-size: 11px; letter-spacing: .5px;
    flex: 0 0 auto;
  }
  .avatar-author { background: linear-gradient(135deg, #6e7781, #afb8c1); }
  .avatar-bot { background: linear-gradient(135deg, #0969da, #54aeff); }
  .comment {
    flex: 1; background: #fff;
    border: 1px solid #d0d7de; border-radius: 6px;
  }
  .comment-header {
    background: #f6f8fa; border-bottom: 1px solid #d0d7de;
    border-radius: 6px 6px 0 0; padding: 8px 16px;
    font-size: 13px; color: #59636e;
  }
  .comment-header strong { color: #1f2328; font-weight: 600; }
  .comment-header .badge {
    display: inline-block; font-size: 11px; padding: 0 7px;
    border-radius: 2em; background: #ddf4ff; color: #0969da;
    border: 1px solid #54aeff66; margin-left: 4px;
    line-height: 18px; vertical-align: 1px;
  }
  .comment-body { padding: 16px; }
  .comment-body h1, .comment-body h2, .comment-body h3 {
    font-weight: 600;
    border-bottom: 1px solid #d0d7de; padding-bottom: .3em;
    margin: 24px 0 16px;
  }
  .comment-body h1 { font-size: 1.5em; }
  .comment-body h2 { font-size: 1.3em; }
  .comment-body h3 { font-size: 1.15em; }
  .comment-body h1:first-child, .comment-body h2:first-child, .comment-body h3:first-child {
    margin-top: 0;
  }
  .comment-body p { margin: 0 0 16px; }
  .comment-body p:last-child { margin-bottom: 0; }
  .comment-body strong { font-weight: 600; }
  .comment-body code {
    font: 12px ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace;
    background: #818b981f; padding: .2em .4em; border-radius: 6px;
  }
  .comment-body pre {
    background: #f6f8fa; border-radius: 6px;
    padding: 12px; overflow-x: auto; margin: 0 0 16px;
  }
  .comment-body pre code {
    background: transparent; padding: 0;
    font-size: 12px; line-height: 1.45;
  }
  .comment-body blockquote {
    border-left: .25em solid #d0d7de;
    padding: 0 1em; color: #59636e;
    margin: 0 0 16px;
  }
  .comment-body ul, .comment-body ol {
    margin: 0 0 16px; padding-left: 2em;
  }
  .comment-body li { margin-bottom: 4px; }
  .comment-body table {
    border-collapse: collapse; margin: 0 0 16px;
    width: 100%; display: table;
  }
  .comment-body table th,
  .comment-body table td {
    border: 1px solid #d0d7de; padding: 6px 13px;
    vertical-align: top;
  }
  .comment-body table th {
    background: #f6f8fa; font-weight: 600; text-align: left;
  }
  .comment-body table tr:nth-child(2n) td { background: #f6f8fa54; }
  .comment-body table img {
    max-width: 100%; height: auto; display: block; border-radius: 4px;
  }
  .comment-body a { color: #0969da; text-decoration: none; }
  .comment-body a:hover { text-decoration: underline; }
  .comment-body hr {
    border: 0; border-top: 1px solid #d0d7de; margin: 16px 0;
  }
  .comment-body input[type="checkbox"] {
    margin-right: 4px;
  }
</style>
</head>
<body>
<div class="page">

<p class="preview-note">
  QA mockup of how this cutter comment would render on the PR. Not posted to GitHub.
  Images load from this directory's <code>before/</code> and <code>after/</code> screenshots.
</p>

<h1 class="pr-title">
  <a href="${escapeAttr(pr.url)}">${escapeHtml(pr.title)}</a>
  <span class="pr-number">#${pr.number}</span>
</h1>

<div class="timeline-item">
  <div class="avatar avatar-author">PR</div>
  <div class="comment">
    <div class="comment-header">
      <strong>PR description</strong>
    </div>
    <div class="comment-body">
${prBodyHtml}
    </div>
  </div>
</div>

<div class="timeline-item">
  <div class="avatar avatar-bot">CUT</div>
  <div class="comment">
    <div class="comment-header">
      <strong>cutter</strong> <span class="badge">bot</span> commented just now
    </div>
    <div class="comment-body">
${commentHtml}
    </div>
  </div>
</div>

</div>
</body>
</html>
`;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
}

function escapeAttr(s: string): string {
  return escapeHtml(s);
}
