# Project-owned settings

A booking app can have its own name, selected teammates, model and saved Skill versions.
These controls manage that project rather than changing instance-wide account settings.

`project-settings.tsx` coordinates detail editing and explicit conflict review.
`project-sharing.tsx` manages owner-reviewed access/model changes.
`project-skills.tsx` pins saved instruction versions for future requests.
`project-archive-controls.tsx` archives/restores with confirmation and preserves history;
it does not delete remote repositories, images or running deployments.

A conflict means the reviewed saved revision changed. An unconfirmed save may already
have committed. Both require explicit recovery; controls retain reviewed text/request
identity instead of silently changing a retry or claiming success. The API owns
permissions, active-work restrictions and saved acknowledgements for every operation.
