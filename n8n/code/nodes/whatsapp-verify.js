// Node "Check verify token": Meta checks the webhook URL with a GET when it is
// saved in the app (WhatsApp > Configuration), carrying AGENT_WA_VERIFY_TOKEN.
// "Reply to Meta" sends back hub.challenge, or 403 for anyone else.
const challenge = waVerify($input.first().json.query, $env.AGENT_WA_VERIFY_TOKEN);
return [{ json: challenge ? { status: 200, reply: challenge } : { status: 403, reply: 'Forbidden' } }];
