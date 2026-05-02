import { render, screen } from '@testing-library/react-native';

import Index from '../app/index';

describe('Index screen', () => {
  it('renders the PlantCare title', () => {
    render(<Index />);
    expect(screen.getByText('PlantCare')).toBeOnTheScreen();
  });
});
