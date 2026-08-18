import { useEffect, useState } from 'react'
import { MantineProvider } from '@mantine/core';
import { Slider, Button, Group } from '@mantine/core';

import '@mantine/core/styles.css';
import './App.css'

export default function App() 
{
    const [songs, set_songs] = useState<string[]>([]);
    const file_path: string = "/home/g4lice/Musics/";

    const [length, set_length] = useState(0);
    const [position, set_position] = useState(0);
    const [paused, set_paused] = useState<boolean>(false);
    const [looped, set_looped] = useState<boolean>(false);
    const [metadata_map, set_metadata_map] = useState<Record<string, string[]>>({});
    const [covers_map, set_covers_map] = useState<Record<string, string>>({});
    
    const icon = paused ? "▶" : "◼"; 
    const looped_icon = looped ? "👍️" : "👎️";

    useEffect(() => {
        const interval = setInterval(async () => {
            const pos = await get_position();
            const len = await get_length();
            
            set_position(pos);
            set_length(len);
        }, 1000);

        return () => clearInterval(interval);
    }, []);

    async function fetch_songs_on_click() {
        // @ts-ignore
        const res_vec = await window.saucer.exposed.fetch_songs(file_path);
        set_songs(res_vec);

        const metadata_map: Record<string, string[]> = {};
        const covers_map: Record<string, string> = {};
        
        for(const name of res_vec) {
            // @ts-ignore
            metadata_map[name] = await window.saucer.exposed.get_metadata(file_path  + name);
            // @ts-ignore
            covers_map[name] = await window.saucer.exposed.get_cover(file_path  + name);
        }

        set_metadata_map(metadata_map);
        set_covers_map(covers_map);
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

    async function toggle_loop() {
        // @ts-ignore
        await window.saucer.exposed.loop();
        set_looped(!looped);
    }

    async function toggle_pause() {
        if (paused) {
            // @ts-ignore
            await window.saucer.exposed.resume();
        } else {
            // @ts-ignore
            await window.saucer.exposed.stop();
        }
        set_paused(!paused);
    }

    return (
        <MantineProvider defaultColorScheme='dark'>
            <div className='app-container'>
                <div className='sidebar'>
                    {
                        
                    }
                </div>
                <div className='main-content'>
                    <Button variant='subtle' color='gray' radius="sm" onClick={fetch_songs_on_click}>Fetch songs</Button>
                        {songs.map((name: string) => (
                            <div key={name} onClick={() => play_music(name)} style={{display: 'flex', alignItems: 'center', gap: '12px', cursor: 'pointer'}}>
                                {covers_map[name] && <img src={`data:image/jpeg;base64,${covers_map[name]}`} width={50} height={50} style={{borderRadius: '4px'}} />}
                                <div>
                                    <div>{metadata_map[name]?.[0] || name}</div>
                                    <div style={{color: 'gray', fontSize: '12px'}}>{metadata_map[name]?.[1] || "Unknown"}</div>
                                </div>
                            </div>
                        ))}
                </div>
                <div className='player-bar'>
                    <Slider value={position} min={0} max={length}/>

                    <Group gap="sm" p="sm" align='center' justify='center'>
                        <Button radius="sm" w={200} onClick={toggle_pause}>{icon}</Button>
                        <Button radius="sm" w={200} onClick={toggle_loop}>Loop: {looped_icon}</Button>
                    </Group>
                </div>
            </div>
        </MantineProvider>
    );
}
