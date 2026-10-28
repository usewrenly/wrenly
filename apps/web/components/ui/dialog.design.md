# Confirmation surfaces

A project owner should be able to read what will happen without the workspace
competing for attention. The supplied Resend confirmation is the visual reference;
Wrenly retains its own warm colours, typography and existing action behaviour.

COMPONENT: Shared dialog presentation
PURPOSE: Give confirmations a calm, clearly separated surface in both themes.
INPUTS: Existing dialog content, actions and open/busy state.
OUTPUTS: A rounded, bordered card above a pale theme-aware blurred backdrop.
STEPS:
1. Keep the existing Base UI portal, focus management, accessible title and dismissal.
2. Fade the underlying app using the page background rather than a heavy black overlay.
3. Give content a wider reading measure, comfortable padding and a quiet border/shadow.
4. Group actions inside the card without a separate tinted footer or divider.
EDGE CASES:
- Narrow viewports retain side margins and stacked actions.
- Dark theme uses the same surface tokens, not a white overlay.
- Busy/action/reconciliation rules stay in the caller, including blocked dismissal.
ERROR STATES:
- Existing errors and uncertain-save controls remain visible; styling grants no action
  authority and adds no keyboard shortcut or typed-confirmation requirement.

Process timelines are a separate follow-up: show actual saved stages and their results,
never invented progress or a successful-looking completion while execution is unknown.
