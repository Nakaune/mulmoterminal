<script setup lang="ts">
// What this SESSION has done to pull requests: `PR #1146 #1150 +2`, newest act first.
//
// The sibling of WorkItemChip, and the two answer different questions on purpose. That one reads
// the directory's current branch, so it goes blank the moment a cell moves on — and it never says
// anything at all in a workspace cell that opens its requests in worktrees somewhere else. This
// one is the session's own record: what it opened, what it edited, wherever it did so.
//
// Renders nothing until the session has touched one, so a cell that has opened no request looks
// exactly as it did before.
import { computed } from "vue";
import { chipSessionPrs, type SessionPr } from "../../common/sessionPr";

const props = defineProps<{
  prs: SessionPr[];
  /** The branch's request, when WorkItemChip is drawing it a few pixels away. Repeating it here
   *  puts the same number on the header twice, which reads as a bug in one of the two chips. */
  hidePr?: number | null;
}>();

// ALL of them. This used to show three and count the rest, because the chip shared row 1 with a
// path that truncated to make room. It now has a line of its own on the roster, so the reason for
// the cap is gone — and a count was the wrong half to keep: "+4" tells you there is more work
// behind this cell without telling you which requests, which is what you came to the roster for.
//
// Deduped by number and stripped of the work chip's request by chipSessionPrs.
const visible = computed(() => chipSessionPrs(props.prs, props.hidePr ?? null));

// The native title rather than the hover tip: this chip is a row of separate links, and the tip
// anchor describes one element. Per-link is also the only place the distinction fits — "opened"
// and "edited" belong to a request, not to the row.
const titleOf = (pr: SessionPr): string => {
  const what = pr.created ? "opened" : "edited";
  return pr.repo === null ? `${what} #${pr.number}` : `${what} ${pr.repo}#${pr.number}`;
};
</script>

<template>
  <!-- No max-width and no `overflow-hidden`: an 18ch cap once silently ate the last number of
       `PR #1313 #1314 #1315` (20ch), and a clipped request number is worse than none — it still
       looks like a number.
       It WRAPS instead, which is what makes showing all of them safe: on its own roster line there
       is a full row to use, and a session with a dozen requests grows downward rather than off the
       edge. That is also why the height is a minimum rather than fixed — a fixed 1.5em would clip
       the second line. -->
  <span
    v-if="visible.length > 0"
    data-testid="session-prs-chip"
    class="inline-flex min-h-[1.5em] flex-wrap items-center gap-x-[0.25em] rounded-[0.75em] bg-[color-mix(in_srgb,currentColor_12%,transparent)] px-[0.4em] font-sans text-[0.72rem] leading-[1.5em] opacity-85"
  >
    <span data-testid="session-prs-label" class="opacity-60">PR</span>
    <a
      v-for="pr in visible"
      :key="pr.url"
      data-testid="session-pr"
      :href="pr.url"
      :title="titleOf(pr)"
      target="_blank"
      rel="noopener"
      class="text-inherit no-underline hover:underline"
      :class="pr.created ? '' : 'opacity-70'"
      >#{{ pr.number }}</a
    >
  </span>
</template>
