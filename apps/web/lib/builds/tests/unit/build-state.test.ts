import { expect, test } from 'bun:test'
import {
  hydrateBuildState,
  INITIAL_BUILD_STATE,
  reduceBuildEvent,
} from '../../build-state'

const files = [{ path: 'app/page.tsx', content: 'broken code' }]

test('failed completion retains files and replaces previously emitted log lines', () => {
  let state = reduceBuildEvent(INITIAL_BUILD_STATE, {
    type: 'file_tree',
    data: { buildId: 'build-1', files },
  })
  state = reduceBuildEvent(state, {
    type: 'log_line',
    data: { line: 'compiler error' },
  })
  state = reduceBuildEvent(state, {
    type: 'complete',
    data: {
      success: false,
      attempt: 3,
      error: 'Build failed',
      buildLog: 'compiler error\n',
    },
  })
  expect(state.files).toEqual(files)
  expect(state.logs).toEqual(['compiler error'])
  expect(state.buildId).toBe('build-1')
  expect(state.phase).toEqual({
    name: 'failed',
    attempt: 3,
    error: 'Build failed',
  })
})

test('restores failed source and error after a reload or history selection', () => {
  const state = hydrateBuildState({
    id: 'failed-build',
    status: 'failed',
    files,
    buildLog: 'compiler error',
    errorMessage: 'Invalid import',
    attemptCount: 2,
    deployedUrl: null,
  })
  expect(state.files).toEqual(files)
  expect(state.phase).toEqual({
    name: 'failed',
    attempt: 2,
    error: 'Invalid import',
  })
  expect(state.streamed).toBe(false)
})

test('numeric attempt and build identity come from the event', () => {
  const state = reduceBuildEvent(INITIAL_BUILD_STATE, {
    type: 'status',
    data: {
      buildId: 'build-2',
      phase: 'retrying',
      message: 'Trying again',
      attempt: 2,
    },
  })
  expect(state.phase).toEqual({
    name: 'retrying',
    message: 'Trying again',
    attempt: 2,
  })
  expect(state.buildId).toBe('build-2')
})

test('rejects an invalid complete event before treating the stream as successful', () => {
  expect(() =>
    reduceBuildEvent(INITIAL_BUILD_STATE, {
      type: 'complete',
      data: { success: 'yes' },
    }),
  ).toThrow('Invalid build result')
})

test('versioned execution events validate, deduplicate and fence different revisions', () => {
  const data = {buildId:'a', attempt:1, operation:'installation', state:'started', occurredAt:new Date().toISOString()}
  const state = reduceBuildEvent({...INITIAL_BUILD_STATE, buildId:'a'}, {type:'activity_v1',id:'2',data})
  expect(state.activity).toHaveLength(1)
  expect(reduceBuildEvent(state,{type:'activity_v1',id:'2',data}).activity).toHaveLength(1)
  expect(reduceBuildEvent(state,{type:'activity_v1',id:'3',data:{...data,buildId:'b'}})).toBe(state)
  expect(() => reduceBuildEvent(state,{type:'activity_v1',id:'3',data:{...data,operation:'browse_web'}})).toThrow()
  expect(() => reduceBuildEvent(state,{type:'activity_v1',id:'3',data:{...data,attempt:99}})).toThrow()
})
