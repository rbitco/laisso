/**
 * The embedded pr-review Pipeline, written to pipelines/pr-review.yaml on first run beside the default one and never
 * touched again. Chosen only with `--pipeline pr-review`: it reviews a teammate's PR, linked as Referenced at Intake.
 */
export const PR_REVIEW_PIPELINE_YAML = `# Lasso's pr-review Pipeline. Edit freely: Lasso never overwrites this file.
# Review a teammate's PR: lasso add "<what to look for>" --pr <pr> --pipeline pr-review
# The findings land in a file in the worktree; you read them and post them.
# It has no tracker Actions, so the teammate's issue is never touched.

stages:
  - name: review-pr
    profile: claude-fable
    skills: [code-review]
    artifact: file review-findings.md
    prompt: |
      Review each Referenced PR on this Ticket with code-review; run
      \`lasso pr list --json\` to see them. The worktree starts at the first
      one's head commit. Write every finding, grouped by PR, with file and
      line, to review-findings.md at the worktree root.
      Do not post anything to any PR: no review, no comment, no approval.
      Do not push. A human reads the findings and posts them.
`;
