import { destination, type Track, ZAPORIZHZHIA } from '@arpha/shared'
import { fireEvent, render, screen } from '@testing-library/svelte'
import { describe, expect, it, vi } from 'vitest'
import ThreatCard from '../src/components/ThreatCard.svelte'
import ThreatPanel from '../src/components/ThreatPanel.svelte'
import TopBar from '../src/components/TopBar.svelte'
import { threatRows } from '../src/lib/view'

const NOW = 1_800_000_000_000
const track = (o: Partial<Track> = {}): Track => ({
  id: 't1',
  type: 'shahed',
  count: 3,
  status: 'active',
  position: destination(ZAPORIZHZHIA, 180, 40),
  speedKmh: 180,
  headingDeg: 0,
  stateAt: NOW,
  uncertaintyKm: 3,
  placeName: 'Балабине',
  target: { name: 'Запоріжжя', ...ZAPORIZHZHIA },
  origin: null,
  prediction: null,
  confidence: 0.8,
  sources: [
    {
      channel: 'zp_monitor',
      channelTitle: 'ЗП Монітор',
      messageId: 77,
      text: 'Шахеди повз Балабине',
      at: NOW,
    },
  ],
  createdAt: NOW,
  updatedAt: NOW - 65_000,
  ...o,
})

describe('TopBar', () => {
  const alert = {
    id: 1,
    locationTitle: 'Запорізька область',
    locationType: 'oblast' as const,
    locationUid: '12',
    alertType: 'air_raid',
    level: 'red',
    threats: [{ type: 'guided_aerial_bombs', level: 'red', startedAt: NOW, message: null }],
    startedAt: NOW,
    featureIds: ['r71980'],
  }

  it('shows an active alert and lists locations on tap', async () => {
    render(TopBar, { level: 'region', alerts: [alert], status: 'online', demo: true })
    const chip = screen.getByTestId('alert-chip')
    expect(chip.textContent).toContain('Повітряна тривога')
    expect(screen.getByText('Демо')).toBeTruthy()
    await fireEvent.click(chip)
    const list = screen.getByRole('list', { name: 'Тривоги в області' })
    expect(list.textContent).toContain('Запорізька область')
    expect(list.textContent).toContain('червоний рівень')
    expect(list.textContent).toContain('КАБи')
    expect(chip.textContent).toContain('КАБи')
  })

  it('shows calm and offline states', () => {
    render(TopBar, { level: 'none', alerts: [], status: 'offline', demo: false })
    expect(screen.getByTestId('alert-chip').textContent).toContain('Тривоги немає')
    expect(screen.getByRole('alert').textContent).toContain('Немає з’єднання')
  })

  it('local alert wording', () => {
    render(TopBar, {
      level: 'mine',
      alerts: [alert, { ...alert, id: 2 }],
      status: 'connecting',
      demo: false,
    })
    expect(screen.getByTestId('alert-chip').textContent).toContain('Тривога у вашій громаді')
  })
})

describe('ThreatPanel', () => {
  it('summarises, lists and selects threats', async () => {
    const onselect = vi.fn()
    const rows = threatRows(
      [track(), track({ id: 't2', status: 'destroyed' })],
      ZAPORIZHZHIA,
      NOW,
      10,
    )
    render(ThreatPanel, { rows, feed: [], selected: null, now: NOW, onselect })
    expect(screen.getByTestId('threat-count').textContent).toContain('1 загроза')
    const items = screen.getAllByTestId('threat-row')
    expect(items).toHaveLength(2)
    expect(items[0]!.textContent).toContain('Шахеди ×3')
    expect(items[0]!.textContent).toMatch(/~10 хв/)
    expect(items[1]!.textContent).toContain('Збито')
    await fireEvent.click(items[0]!)
    expect(onselect).toHaveBeenCalledWith('t1')
  })

  it('empty state', () => {
    render(ThreatPanel, { rows: [], feed: [], selected: null, now: NOW, onselect: vi.fn() })
    expect(screen.getAllByText('Активних загроз не зафіксовано').length).toBeGreaterThan(0)
  })

  it('shows the card for the selected threat', () => {
    const rows = threatRows([track()], ZAPORIZHZHIA, NOW, 10)
    render(ThreatPanel, { rows, feed: [], selected: 't1', now: NOW, onselect: vi.fn() })
    expect(screen.getByTestId('threat-card')).toBeTruthy()
  })
})

describe('ThreatCard', () => {
  it('renders kinematics, ETA and linked sources', async () => {
    const onclose = vi.fn()
    const [row] = threatRows([track()], ZAPORIZHZHIA, NOW, 10)
    render(ThreatCard, { row: row!, now: NOW, onclose })
    expect(screen.getByRole('heading', { level: 2 }).textContent).toBe('Шахеди ×3')
    expect(screen.getByTestId('card-eta').textContent).toBe('~10 хв')
    expect(screen.getByText('~180 км/год')).toBeTruthy()
    expect(screen.getByText('пн (0°)')).toBeTruthy()
    const link = screen.getByRole('link', { name: /ЗП Монітор/ }) as HTMLAnchorElement
    expect(link.href).toBe('https://t.me/zp_monitor/77')
    expect(link.rel).toContain('noopener')
    await fireEvent.click(screen.getByRole('button', { name: 'Закрити' }))
    expect(onclose).toHaveBeenCalled()
  })

  it('shows closest approach for a passing threat and status badges', () => {
    const passing = track({
      position: destination(destination(ZAPORIZHZHIA, 270, 30), 180, 40),
      target: null,
    })
    const [row] = threatRows([passing], ZAPORIZHZHIA, NOW, 10)
    render(ThreatCard, { row: row!, now: NOW, onclose: vi.fn() })
    expect(screen.getByText('Найближче зближення')).toBeTruthy()
    expect(screen.getByTestId('card-eta').textContent).toBe('Курс не на вас')
  })

  it('destroyed threat', () => {
    const [row] = threatRows([track({ status: 'destroyed', sources: [] })], ZAPORIZHZHIA, NOW, 10)
    render(ThreatCard, { row: row!, now: NOW, onclose: vi.fn() })
    expect(screen.getByText('Збито')).toBeTruthy()
    expect(screen.queryByTestId('card-eta')).toBeNull()
  })
})
