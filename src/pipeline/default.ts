/** The embedded default Pipeline, written to pipelines/default.yaml on first run and never touched again. */
export const DEFAULT_PIPELINE_YAML = `# Lasso's default Pipeline. Edit freely: Lasso never overwrites this file.
# Runner-run Stages take a prompt and/or skills; action Stages take an action.
# A Runner Stage runs under the profile: it names, else the Pipeline's, else
# config.yaml's default_profile. Thinking Stages use Fable, docs use Sonnet.

stages:
  - name: grill
    profile: claude-fable
    human: true
    advance: false
    skills: [grilling, domain-modeling, to-spec]
    artifact: tracker-spec
    prompt: |
      Grill the Ticket's idea until we share an understanding, sharpening
      the glossary and recording ADRs as we go. Then publish the spec to the
      tracker with to-spec. For a prompt Ticket, to-spec creates the issue.

  - action: tracker.transition
    with: { status: In Progress }

  - name: plan
    profile: claude-fable
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
    profile: claude-sonnet
    skills: [domain-modeling]
    artifact: pr-exists
    prompt: |
      Update repo docs, CONTEXT.md, and ADRs for the change on this branch.
      Write the PR body from the spec and the diff. Push and open the PR.

  - name: code-review
    profile: claude-fable
    skills: [code-review]
    artifact: pr-review
    prompt: |
      Review each Owned PR of this Ticket ("lasso pr list" names them)
      against its base with code-review. Post one PR review per Owned PR
      with inline comments, each carrying Lasso's Stage marker, so the
      Review Stage addresses them as Feedback. Leave Referenced PRs alone.

  - action: tracker.transition
    with: { status: In Review }

  - name: review
    repeat: feedback
    artifact: pr-merged
    prompt: |
      Address each unaddressed Feedback item below on this branch: failed
      checks and review threads. Reply on each thread with the marker,
      commit, and push. Then resolve each thread you fixed; Lasso counts a
      thread addressed only once it has a marked reply and is resolved.
      Leave a thread unresolved when you could not fix it, and say why in
      your reply.

  - action: tracker.transition
    with: { status: Done }
`;
