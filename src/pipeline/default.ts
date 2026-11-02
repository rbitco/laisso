/** The embedded default Pipeline, written to pipelines/default.yaml on first run and never touched again. */
export const DEFAULT_PIPELINE_YAML = `# Laisso's starter Pipeline. Edit freely: Laisso never overwrites this file.
# It needs only a Runner and gh: no skills, no tracker Actions. \`laisso setup\`
# helps you shape it to how you work. A Runner Stage runs under the profile:
# it names, else the Pipeline's, else config.yaml's default_profile.

stages:
  - name: plan
    human: true
    advance: false
    artifact: file PLAN.md
    prompt: |
      Work out with me how to do this Ticket. Explore the repo, ask what you
      need to know, and agree a plan: what changes and where, the tests that
      prove it, and the order of the steps. Write the plan to PLAN.md at the
      worktree root and change no code. I mark this Stage done when we agree.

  - name: implement
    artifact: commits-on-branch
    prompt: |
      Carry out PLAN.md on the current branch. Add or update tests for the
      change and run the repo's tests and linters until they pass. Commit as
      you go, leaving PLAN.md out of every commit. Do not push.

  - name: open-pr
    artifact: pr-exists
    prompt: |
      Push the branch and open a pull request with gh. Write its title and
      body from PLAN.md and the diff: what changed, why, and how it was
      tested. Leave PLAN.md out of the PR.

  - name: review
    repeat: feedback
    artifact: pr-merged
    prompt: |
      Address each unaddressed Feedback item below on this branch: failed
      checks and review threads. Reply on each thread with the marker,
      commit, and push. Then resolve each thread you fixed; Laisso counts a
      thread addressed only once it has a marked reply and is resolved.
      Leave a thread unresolved when you could not fix it, and say why in
      your reply.
`;
