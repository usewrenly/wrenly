import { expect, test } from 'bun:test'
import { parseProjectList, type Project } from '../../contracts'
const project: Project = { id: 'project', name: 'Booking app', stack: 'laravel', createdAt: '2026-10-23T00:00:00Z', updatedAt: '2026-10-23T00:00:00Z', latestBuild: null }
test('project summaries retain display fields without execution metadata', () => {
  expect(parseProjectList({ projects: [{ ...project, prompt: 'private metadata', token: 'secret' }] })).toEqual([project])
})
test('malformed project lists fail instead of becoming an empty or invented state', () => {
  for (const value of [{}, { projects: null }, { projects: [{ ...project, owned: 'true' }] },
    { projects: [{ ...project, updatedAt: 'invalid' }] }, { projects: [{ ...project, latestBuild: { status: 'success' } }] }])
    expect(() => parseProjectList(value)).toThrow('could not be read')
})

test('project summaries cannot introduce executable deployed-app links', () => {
  const build = { id: 'build', status: 'success', attemptCount: 1, createdAt: project.createdAt, deployedUrl: 'https://app.example.test' }
  expect(parseProjectList({ projects: [{ ...project, latestBuild: build }] })[0]?.latestBuild?.deployedUrl).toBe(build.deployedUrl)
  for (const url of ['javascript:alert(1)', 'https://user:secret@example.test', '/relative'])
    expect(() => parseProjectList({ projects: [{ ...project, latestBuild: { ...build, deployedUrl: url } }] })).toThrow()
})
