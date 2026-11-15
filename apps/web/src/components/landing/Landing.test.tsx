// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Landing } from './Landing';

describe('Landing', () => {
  afterEach(() => cleanup());

  it('leads with the headline and opens the sky viewer once, even on a double click', async () => {
    const onExplore = vi.fn();
    render(<Landing onExplore={onExplore} onTour={vi.fn()} />);
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Explore the invisible universe.');
    const explore = screen.getByRole('button', { name: 'Explore the Sky' });
    fireEvent.click(explore);
    fireEvent.click(explore);
    await waitFor(() => expect(onExplore).toHaveBeenCalledTimes(1));
    await new Promise((r) => setTimeout(r, 20));
    expect(onExplore).toHaveBeenCalledTimes(1);
  });

  it('fades out over the viewer and then reports that it is gone', async () => {
    const onExited = vi.fn();
    const { container } = render(<Landing onExplore={vi.fn()} onTour={vi.fn()} leaving onExited={onExited} />);
    expect(container.querySelector('.landing')?.classList.contains('landing-leaving')).toBe(true);
    expect(onExited).not.toHaveBeenCalled(); // the fade is still running
    await waitFor(() => expect(onExited).toHaveBeenCalledTimes(1), { timeout: 1500 });
  });

  it('starts the guided tour through the same jump into the viewer', async () => {
    const onExplore = vi.fn();
    const onTour = vi.fn();
    render(<Landing onExplore={onExplore} onTour={onTour} />);
    fireEvent.click(screen.getByRole('button', { name: 'Guided Tour' }));
    await waitFor(() => expect(onTour).toHaveBeenCalledTimes(1));
    expect(onExplore).not.toHaveBeenCalled();
  });

  it('answers the four context questions', () => {
    render(<Landing onExplore={vi.fn()} onTour={vi.fn()} />);
    const context = screen.getByRole('region', { name: 'A little context before you explore' });
    expect(within(context).getAllByRole('heading', { level: 3 }).map((h) => h.textContent)).toEqual([
      'What is SPHEREx?',
      'Where does the data come from?',
      'What can I explore?',
      'What are astronomical catalogs?',
    ]);
  });

  it('links to the official sources in a new tab and states it is not an official NASA app', () => {
    render(<Landing onExplore={vi.fn()} onTour={vi.fn()} />);
    const footer = screen.getByRole('contentinfo');
    const hrefs = within(footer).getAllByRole('link').map((a) => a.getAttribute('href'));
    expect(hrefs).toEqual([
      'https://science.nasa.gov/mission/spherex/',
      'https://irsa.ipac.caltech.edu/Missions/spherex.html',
      'https://irsa.ipac.caltech.edu/onlinehelp/spherex/spherex/overview.html',
      'https://spherex.caltech.edu/',
    ]);
    for (const link of within(footer).getAllByRole('link')) {
      expect(link.getAttribute('target')).toBe('_blank');
      expect(link.getAttribute('rel')).toBe('noopener noreferrer');
    }
    expect(footer.textContent).toContain('Not an official NASA application.');
  });
});
