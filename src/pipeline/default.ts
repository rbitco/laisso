/** The embedded default Pipeline, written to pipelines/default.yaml on first run and never touched again. */
export const DEFAULT_PIPELINE_YAML = `# Lasso's default Pipeline. Edit freely: Lasso never overwrites this file.
# Runner-run Stages take a prompt and/or skills; action Stages take an action.
runner: claude

stages:
  - name: grill
    human: true
    advance: false
    skills: [grilling, domain-modeling, to-spec]
    artifact: tracker-spec
    prompt: |
      Grill the Ticket's idea until we share an understanding, sharpening
      the glossary and recording ADRs as we go. Then publish the spec to the
      tracker with to-spec. For a prompt Ticket, to-spec creates the issue.

  - action: tracker.transition
    status: In Progress

  - name: plan
    skills: [codebase-design]
    artifact: tracker-comment
    prompt: |
      Read the spec on the Ticket's issue and explore the repo. Write an
      implementation plan: seams to test at, modules touched, test approach,
      ordered steps. Post it as a comment on the issue.

  - name: implement
    skills: [implement]
    artifact: commits-on-branch
    prompt: |
      Implement the spec on the Ticket's issue, following the plan comment.
      Commit to the current branch; do not push.

  - name: document
    skills: [domain-modeling]
    artifact: pr-exists
    prompt: |
      Update repo docs, CONTEXT.md, and ADRs for the change on this branch.
      Write the PR body from the spec and the diff. Push and open the PR.

  - name: code-review
    skills: [code-review]
    artifact: pr-review
    prompt: |
      Review this branch against main with code-review. Post the findings
      as one PR review with inline comments, each carrying Lasso's Stage
      marker, so the Review Stage addresses them as Feedback.

  - action: tracker.transition
    status: In Review

  - name: review
    repeat: feedback
    artifact: pr-merged
    prompt: |
      Address each unaddressed Feedback item below on this branch: failed
      checks and review threads. Reply on each thread with the marker,
      commit, and push.

  - action: tracker.transition
    status: Done
`;
