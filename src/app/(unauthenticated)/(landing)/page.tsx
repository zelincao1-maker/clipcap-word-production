import { Container, Stack } from '@mantine/core';
import { HomeHero } from '@/src/app/(authenticated)/(home)/home/_components/HomeHero';
import { HomeRecentProjects } from '@/src/app/(authenticated)/(home)/home/_components/HomeRecentProjects';

export default function LandingPage() {
  return (
    <Container py={28}>
      <Stack gap={40}>
        <HomeHero />
        <HomeRecentProjects />
      </Stack>
    </Container>
  );
}
