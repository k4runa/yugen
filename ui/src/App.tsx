import { useEffect, useState } from 'react'
import { MantineProvider } from '@mantine/core';
import { Stack, Slider, Button } from '@mantine/core';

import '@mantine/core/styles.css';
import './App.css'

export default function App() 
{
    const [covers, set_covers] = useState<string[]>([]);
    const file_path: string = "/home/g4lice/Musics/";

    const [length, set_length] = useState(0);
    const [position, set_position] = useState(0);


    useEffect(() => {
        const interval = setInterval(async () => {
            const pos = await get_position();
            const len = await get_length();
            
            set_position(pos);
            set_length(len);
        }, 1000);

        return () => clearInterval(interval);
    });

    async function fetch_covers_on_click() {
        // @ts-ignore
        const res_vec = await window.saucer.exposed.fetch_covers(file_path);
        set_covers(res_vec);
    }

    async function play_music(cover_name: string) {
        // @ts-ignore
        await window.saucer.exposed.play_music(file_path + cover_name);    
    }

    async function get_position() {
        // @ts-ignore
        const res = await window.saucer.exposed.get_position();
        return res;
    }
    
    async function get_length() {
        // @ts-ignore
        const res = await window.saucer.exposed.get_length();
        return res;
    }

    async function stop() {
        // @ts-ignore
        await window.saucer.exposed.stop();     
    }

    async function resume()  {
        // @ts-ignore
        await window.saucer.exposed.resume();     
    }

    async function toggle_loop() {
        // @ts-ignore
        await window.saucer.exposed.loop();     
    }

    return (
        <MantineProvider defaultColorScheme='dark'>
            <Stack gap="md" p="md">
                <Button variant='subtle' color='gray' radius="sm" onClick={fetch_covers_on_click}>Fetch covers</Button>
                {covers.map((name: string) => (
                    <Button key={name} onClick={() => play_music(name)} variant='subtle' color='gray' radius="sm">{name}</Button>
                ))}

                <Slider value={position} min={0} max={length}/>
                
                <Stack gap="sm" p="sm" align='center'>
                    <Button radius="sm" w={200} onClick={stop}>Stop</Button>
                    <Button radius="sm" w={200} onClick={resume}>Resume</Button>
                    <Button radius="sm" w={200} onClick={toggle_loop}>Loop</Button>
                </Stack>
            </Stack>
        </MantineProvider>
    );
}
