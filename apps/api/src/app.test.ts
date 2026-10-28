import { createInstanceAccessHandler } from './modules/auth/access/instance-access'
import { expect, mock, test } from 'bun:test'
import { createApp, type ApiHandlers } from './app'
import { readBuildEvents } from '../../web/lib/builds/build-events'

const PROJECT_ID = '101e4567-e89b-12d3-a456-426614174007'

function fixture(): {
  app: ReturnType<typeof createApp>
  handlers: ApiHandlers
} {
  const handlers: ApiHandlers = {
    listProjects: mock(async () => Response.json({ projects: [] })),
    createProject: mock(async () =>
      Response.json({ project: { id: PROJECT_ID } }, { status: 201 }),
    ),
    getProject: mock(async (_request, id) =>
      Response.json({ project: { id }, builds: [] }),
    ),
    deployProject: mock(async () =>
      Response.json({ error: 'Nothing to deploy yet' }, { status: 400 }),
    ),
    getModels: mock(async () =>
      Response.json({ models: [], providers: [], envDefault: 'local' }),
    ),
    generate: mock(
      async () =>
        new Response(
          ': heartbeat\n\nevent: complete\ndata: {"success":true,"attempt":1}\n\n',
          { headers: { 'Content-Type': 'text/event-stream' } },
        ),
    ),

    auth: mock(async (request) =>
      Response.json(
        { cookie: request.headers.get('Cookie') },
        { headers: { 'Set-Cookie': 'test-session=value; HttpOnly; Path=/' } },
      ),
    ),
  }
  return {
    app: createApp(handlers, {
      web: 'http://localhost:3000',
      api: 'http://localhost:3002',
    }),
    handlers,
  }
}

test('serves health and keeps the existing project/model paths', async () => {
  const { app } = fixture()
  expect((await (await app.request('/api/health')).json()).service).toBe(
    'wrenly-api',
  )
  expect((await app.request('/api/projects')).status).toBe(200)
  expect((await app.request('/api/models')).status).toBe(200)
  expect(
    (await app.request('/api/projects', { method: 'POST', body: '{}' })).status,
  ).toBe(201)
})

test('passes project identity and native request headers to the handler', async () => {
  const { app, handlers } = fixture()
  const response = await app.request(`/api/projects/${PROJECT_ID}`, {
    headers: { Cookie: 'session=value' },
  })
  expect(response.status).toBe(200)
  expect(handlers.getProject).toHaveBeenCalledTimes(1)
  expect((await response.json()).project.id).toBe(PROJECT_ID)
})

test('validates UUIDs before invoking project handlers', async () => {
  const { app, handlers } = fixture()
  expect((await app.request('/api/projects/not-a-uuid')).status).toBe(400)
  expect(
    (await app.request('/api/projects/not-a-uuid/deploy', { method: 'POST' }))
      .status,
  ).toBe(400)
  expect(handlers.getProject).not.toHaveBeenCalled()
  expect(handlers.deployProject).not.toHaveBeenCalled()
})

test('mounts native auth without dropping session cookies', async () => {
  const { app, handlers } = fixture()
  const response = await app.request('/api/auth/get-session', {
    headers: { Cookie: 'session=value' },
  })
  expect((await response.json()).cookie).toBe('session=value')
  expect(response.headers.get('Set-Cookie')).toContain('HttpOnly')
  expect(handlers.auth).toHaveBeenCalledTimes(1)
})

test('preserves unauthorized handler outcomes', async () => {
  const { app, handlers } = fixture()
  handlers.listProjects = async () =>
    Response.json({ error: 'Unauthorized' }, { status: 401 })
  expect((await app.request('/api/projects')).status).toBe(401)
})

test('returns credentialed CORS preflight and rejects foreign browser mutations', async () => {
  const { app, handlers } = fixture()
  const preflight = await app.request('/api/generate', {
    method: 'OPTIONS',
    headers: {
      Origin: 'http://localhost:3000',
      'Access-Control-Request-Method': 'POST',
    },
  })
  expect(preflight.status).toBe(204)
  expect(preflight.headers.get('Access-Control-Allow-Origin')).toBe(
    'http://localhost:3000',
  )
  expect(preflight.headers.get('Access-Control-Allow-Credentials')).toBe('true')
  expect(
    (
      await app.request('/api/generate', {
        method: 'POST',
        headers: { Origin: 'https://untrusted.example' },
        body: '{}',
      })
    ).status,
  ).toBe(403)
  expect(handlers.generate).not.toHaveBeenCalled()
})

test('streams the existing event contract through Hono without buffering or wrapping it', async () => {
  const { app } = fixture()
  const response = await app.request('/api/generate', {
    method: 'POST',
    body: '{}',
  })
  expect(response.headers.get('Content-Type')).toContain('text/event-stream')
  if (!response.body) throw new Error('Missing stream')
  const events: string[] = []
  await readBuildEvents(response.body, (event) => {
    events.push(event.type)
  })
  expect(events).toEqual(['complete'])
})

test('unexpected handler failures return safe JSON rather than HTML or raw exceptions', async () => {
  const { app, handlers } = fixture()
  handlers.getModels = async () => {
    throw new Error('Internal diagnostic detail')
  }
  const response = await app.request('/api/models')
  expect(response.status).toBe(500)
  expect(response.headers.get('Content-Type')).toContain('application/json')
  expect(await response.text()).not.toContain('Internal diagnostic detail')
  expect((await app.request('/api/missing')).status).toBe(404)
})


test('registers the optional durable build contract without enabling it implicitly', async () => {
  const { handlers } = fixture()
  expect((await fixture().app.request('/api/builds')).status).toBe(404)
  handlers.builds = {
    activity: async (_request, id) => Response.json({buildId:id,activity:[]}),
    create: async () => Response.json({ buildId: PROJECT_ID }, { status: 202 }),
    get: async (_request, id) => Response.json({ id }),
    events: async () => new Response('id: 1\nevent: complete\ndata: {"success":true}\n\n', { headers: { 'Content-Type': 'text/event-stream' } }),
    cancel: async () => Response.json({ cancellationRequested: true }),
  }
  const app = createApp(handlers, { web: 'http://localhost:3000', api: 'http://localhost:3002' })
  expect((await app.request('/api/builds', { method: 'POST' })).status).toBe(202)
  expect((await (await app.request(`/api/builds/${PROJECT_ID}`)).json()).id).toBe(PROJECT_ID)
  expect(await (await app.request(`/api/builds/${PROJECT_ID}/events`)).text()).toContain('id: 1')
  expect((await (await app.request(`/api/builds/${PROJECT_ID}/activity`)).json()).buildId).toBe(PROJECT_ID)
  expect((await app.request(`/api/builds/${PROJECT_ID}/cancel`, { method: 'POST' })).status).toBe(200)
})


test('instance access route forwards the current session and retains safe unavailable responses', async () => {
  const { handlers } = fixture()
  for (const failure of [false, true]) {
    handlers.instanceAccess = createInstanceAccessHandler({ singleUser: false, userId: async headers => {
      expect(headers.get('cookie')).toBe('session=fixture')
      if (failure) throw new Error('private diagnostic')
      return 'fixture-owner'
    } })
    const app = createApp(handlers, { web: 'http://localhost:3000', api: 'http://localhost:3002' })
    const response = await app.request('/api/instance/access', { headers: { Cookie: 'session=fixture' } })
    expect(response.status).toBe(failure ? 503 : 200)
    expect(response.headers.get('cache-control')).toContain('no-store')
    if (!failure) expect(await response.json()).toEqual({ mode: 'multi-user', access: 'authenticated' })
    else expect(await response.text()).not.toContain('private diagnostic')
  }
})

test('database collection/view routes require explicit handlers and preserve their authenticated responses', async () => {
  const { handlers, app: inactive } = fixture()
  expect((await inactive.request(`/api/projects/${PROJECT_ID}/databases`)).status).toBe(404)
  const status = mock(async () => Response.json({ error: 'Sign in' }, { status: 401 }))
  const view = mock(async () => Response.json({ error: 'Sign in' }, { status: 401 }))
  const app = createApp({ ...handlers, projectDatabases: { status, view } }, { web: 'http://localhost:3000', api: 'http://localhost:3002' })
  expect((await app.request(`/api/projects/${PROJECT_ID}/databases`)).status).toBe(401)
  expect((await app.request(`/api/projects/${PROJECT_ID}/databases/view?rows=false`)).status).toBe(401)
  expect(status).toHaveBeenCalledTimes(1)
  expect(view).toHaveBeenCalledTimes(1)
})

test('database writes and receipt lookups are installed only with explicit command handlers', async () => {
  const { handlers, app: inactive } = fixture()
  const path = `/api/projects/${PROJECT_ID}/databases/actions`
  expect((await inactive.request(path, { method: 'POST' })).status).toBe(404)
  expect((await inactive.request(`${path}/${PROJECT_ID}`)).status).toBe(404)
  const denied = async (): Promise<Response> => Response.json({ error: 'Sign in' }, { status: 401 })
  const submit = mock(denied)
  const acknowledgement = mock(denied)
  const app = createApp({ ...handlers, projectDatabases: { status: denied, view: denied,
    actions: { submit, acknowledgement } } }, { web: 'http://localhost:3000', api: 'http://localhost:3002' })
  expect((await app.request(path, { method: 'POST' })).status).toBe(401)
  expect((await app.request(`${path}/${PROJECT_ID}`)).status).toBe(401)
  expect(submit).toHaveBeenCalledTimes(1)
  expect(acknowledgement).toHaveBeenCalledTimes(1)
})


test('database review and recovery routes remain opt-in and preserve handler authority', async () => {
  const { handlers, app: inactive } = fixture()
  const root = `/api/projects/${PROJECT_ID}/databases`
  for (const path of ['migration-review', 'recovery-review', `recovery/${PROJECT_ID}`])
    expect((await inactive.request(`${root}/${path}`)).status).toBe(404)
  expect((await inactive.request(`${root}/recovery`, { method: 'POST' })).status).toBe(404)
  const denied = mock(async (): Promise<Response> => Response.json({ error: 'Denied' }, { status: 403 }))
  const app = createApp({ ...handlers, projectDatabases: { status: denied, view: denied,
    migrationReview: denied, recoveryReview: denied, recovery: { submit: denied, acknowledgement: denied } } },
    { web: 'http://localhost:3000', api: 'http://localhost:3002' })
  for (const path of ['migration-review', 'recovery-review', `recovery/${PROJECT_ID}`])
    expect((await app.request(`${root}/${path}`)).status).toBe(403)
  expect((await app.request(`${root}/recovery`, { method: 'POST' })).status).toBe(403)
  expect(denied).toHaveBeenCalledTimes(4)
})

test('project settings registers both methods without a dynamic Hono overload and validates IDs first', async () => {
  const { handlers } = fixture()
  const get = mock(async (_request: Request, id: string): Promise<Response> => Response.json({ id, operation: 'read' }))
  const save = mock(async (_request: Request, id: string): Promise<Response> => Response.json({ id, operation: 'save' }, { status: 409 }))
  const app = createApp({ ...handlers, projectSettings: { get, save } }, { web: 'http://localhost:3000', api: 'http://localhost:3002' })
  const path = `/api/projects/${PROJECT_ID}/settings`
  expect(await (await app.request(path)).json()).toEqual({ id: PROJECT_ID, operation: 'read' })
  expect((await app.request(path, { method: 'PATCH', headers: { Origin: 'http://localhost:3000' } })).status).toBe(409)
  for (const method of ['GET', 'PATCH']) expect((await app.request('/api/projects/invalid/settings', { method, headers: { Origin: 'http://localhost:3000' } })).status).toBe(400)
  expect(get).toHaveBeenCalledTimes(1)
  expect(save).toHaveBeenCalledTimes(1)
})
