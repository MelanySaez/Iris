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
    expect(within(context).getAllByRole('article').map((a) => within(a).getByRole('heading', { level: 3 }).textContent)).toEqual([
      'What is SPHEREx?',
      'Where does the data come from?',
      'What can I explore?',
      'What are astronomical catalogs?',
    ]);
  });

  it('names every catalog layer the map can show, below the four questions', () => {
    render(<Landing onExplore={vi.fn()} onTour={vi.fn()} />);
    const strip = screen.getByRole('region', { name: 'Catalog layers on the map' });
    const names = within(strip).getAllByRole('listitem').map((li) => li.querySelector('strong')?.textContent);
    expect(names).toEqual(['SIMBAD', 'Gaia DR3', 'CatWISE2020', 'Iris featured objects']);
    const links = within(strip).getAllByRole('link');
    expect(links.map((a) => a.getAttribute('href'))).toEqual([
      'https://simbad.cds.unistra.fr/',
      'https://www.cosmos.esa.int/web/gaia/dr3',
      'https://catwise.github.io/',
    ]);
    for (const link of links) expect(link.getAttribute('target')).toBe('_blank');
  });

  it('leaves the catalog question without its own link', () => {
    render(<Landing onExplore={vi.fn()} onTour={vi.fn()} />);
    const card = screen.getByRole('heading', { name: 'What are astronomical catalogs?' }).closest('article') as HTMLElement;
    expect(within(card).queryByRole('link')).toBeNull();
  });

  it('introduces the team with each member linking to their GitHub profile', () => {
    render(<Landing onExplore={vi.fn()} onTour={vi.fn()} />);
    const team = screen.getByRole('region', { name: 'The team' });
    const links = within(team).getAllByRole('link');
    expect(links.map((a) => a.textContent?.trim())).toEqual([
      expect.stringContaining('Melany Marcela Saez Acuña'),
      expect.stringContaining('Juan Diego Pérez Navarro'),
      expect.stringContaining('Aarón Dalí López Fortich'),
      expect.stringContaining('Gabriel Alejandro Mantilla Clavijo'),
    ]);
    expect(links.map((a) => a.getAttribute('href'))).toEqual([
      'https://github.com/MelanySaez',
      'https://github.com/dosquisd',
      'https://github.com/AaronDLF',
      'https://github.com/Gavimantilla',
    ]);
    for (const link of links) expect(link.getAttribute('target')).toBe('_blank');
  });

  it('shows each member as a plain card: name and GitHub handle, no picture', () => {
    render(<Landing onExplore={vi.fn()} onTour={vi.fn()} />);
    const team = screen.getByRole('region', { name: 'The team' });
    expect(team.querySelector('img, .landing-team-avatar')).toBeNull();
    const [first] = within(team).getAllByRole('link');
    expect(first.textContent).toBe('Melany Marcela Saez Acuña@MelanySaez');
  });

  it('jumps to the team from the top navigation', () => {
    render(<Landing onExplore={vi.fn()} onTour={vi.fn()} />);
    const nav = screen.getByRole('navigation', { name: 'Landing' });
    expect(within(nav).getAllByRole('button').map((b) => b.textContent)).toEqual(['About', 'Team', 'Resources']);
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
